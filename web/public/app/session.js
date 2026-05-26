// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api, showError, flashStatus } from "./api.js";
import { syncPromptRuntime, renderRequest, flushPromptDraftFromEditor, setupPackageToggle } from "./prompt.js";
import { renderOutput, renderTimeline, renderRunState, renderTodoPanel, renderTodo } from "./output.js";
import { renderTools, applyEnabledTools } from "./tools.js";
import { renderCommands, setTimelineFilter } from "./commands.js";
import { loadConfig, saveConfig, openConfigDialog } from "./config.js";
import { loadTraces, renderTraces } from "./traces.js";
import { loadSkills, openSkillEditor, saveSkill, deleteSkill, reloadSkills } from "./skills.js";
import { copyTraceExport, downloadTraceExport } from "./trace-export.js";
import { copyTimelineExport, downloadTimelineExport } from "./timeline-export.js";
import { SESSION_STORAGE_KEY } from "./state.js";

const ACCEPTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;

export function formatCwdShort(cwd) {
  if (!cwd) return "—";
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return cwd;
  const tail = parts[parts.length - 1];
  return parts.length > 1 ? `…/${tail}` : tail;
}

export function setTopbarTitles(model, cwd) {
  const sessionInline = document.getElementById("sessionInline");
  const workspaceInline = document.getElementById("workspaceInline");
  if (sessionInline) sessionInline.title = model || "No session";
  if (workspaceInline) workspaceInline.title = cwd || "—";
}

export async function init() {
  restoreSidebarState();
  restoreTimelineState();
  bindEvents();
  await loadTraces();
  await loadSkills();
  const config = await loadConfig();
  if (config.setupRequired) {
    els.configDialog.showModal();
    return;
  }
  await resumeOrStartSession();
}

export function bindEvents() {
  els.toggleSidebar.addEventListener("click", toggleSidebar);
  els.toggleTimeline.addEventListener("click", toggleTimeline);
  els.sidebarPanelToggles.forEach((heading) => {
    heading.addEventListener("click", (event) => {
      if (event.target.closest("button,input")) return;
      heading.closest(".sidebar-panel")?.classList.toggle("collapsed");
    });
  });
  els.refreshTraces.addEventListener("click", () => loadTraces());
  els.traceSearch.addEventListener("input", renderTraces);
  els.toolSearch.addEventListener("input", renderTools);
  els.applyTools.addEventListener("click", applyEnabledTools);
  els.clearSession.addEventListener("click", clearSession);
  els.newSkill.addEventListener("click", () => openSkillEditor());
  if (els.reloadSkills) els.reloadSkills.addEventListener("click", () => reloadSkills());
  els.composer.addEventListener("submit", submitPrompt);
  els.abortRun.addEventListener("click", abortRun);
  els.copyTrace.addEventListener("click", copyTraceExport);
  els.exportTrace.addEventListener("click", downloadTraceExport);
  els.copyTimeline.addEventListener("click", copyTimelineExport);
  els.exportTimeline.addEventListener("click", downloadTimelineExport);
  els.timelineFilter.addEventListener("change", renderTimeline);
  els.timelineFilterButtons.forEach((button) => {
    button.addEventListener("click", () => setTimelineFilter(button.dataset.timelineFilter));
  });
  els.openConfig.addEventListener("click", openConfigDialog);
  els.configForm.addEventListener("submit", saveConfig);
  els.providerInput.addEventListener("change", () => {
    els.baseUrlInput.value = View.providerBaseURLFor(els.providerInput.value, state.providers);
  });
  els.skillForm.addEventListener("submit", saveSkill);
  els.deleteSkill.addEventListener("click", deleteSkill);
  bindComposerImageEvents();
  setupPackageToggle();
}

function bindComposerImageEvents() {
  if (els.composerImageInput) {
    els.composerImageInput.addEventListener("change", (event) => {
      const files = [...(event.target.files || [])];
      if (files.length) addPendingImages(files);
      event.target.value = "";
    });
  }
  if (els.composer) {
    els.composer.addEventListener("dragover", (event) => {
      if (!eventHasFiles(event)) return;
      event.preventDefault();
      els.composer.classList.add("dragging");
    });
    els.composer.addEventListener("dragleave", (event) => {
      if (event.target !== els.composer) return;
      els.composer.classList.remove("dragging");
    });
    els.composer.addEventListener("drop", (event) => {
      if (!eventHasFiles(event)) return;
      event.preventDefault();
      els.composer.classList.remove("dragging");
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) addPendingImages(files);
    });
  }
  if (els.promptInput) {
    els.promptInput.addEventListener("paste", (event) => {
      const items = [...(event.clipboardData?.items || [])];
      const files = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file && ACCEPTED_IMAGE_MIME.has(file.type)) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        addPendingImages(files);
      }
    });
  }
  if (els.composerAttachments) {
    els.composerAttachments.addEventListener("click", (event) => {
      const removeBtn = event.target.closest("[data-attachment-remove]");
      if (removeBtn) {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(removeBtn.getAttribute("data-attachment-remove"));
        removePendingImage(index);
      }
    });
  }
}

function eventHasFiles(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  if (typeof types.includes === "function") return types.includes("Files");
  for (const type of types) if (type === "Files") return true;
  return false;
}

export async function addPendingImages(files) {
  const accepted = [];
  for (const file of files) {
    if (!ACCEPTED_IMAGE_MIME.has(file.type)) {
      showError(`Unsupported image type: ${file.type || file.name}`, { scope: "ui" });
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showError(`Image too large (max 5 MB): ${file.name}`, { scope: "ui" });
      continue;
    }
    if (state.pendingImages.length + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      showError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`, { scope: "ui" });
      break;
    }
    accepted.push(file);
  }
  for (const file of accepted) {
    try {
      const dataUrl = await readFileAsDataURL(file);
      state.pendingImages.push({
        name: file.name,
        mimeType: file.type,
        dataUrl,
        size: file.size,
      });
    } catch (error) {
      showError(`Failed to read ${file.name}: ${error?.message || error}`, { scope: "ui" });
    }
  }
  renderComposerAttachments();
}

export function removePendingImage(index) {
  if (index < 0 || index >= state.pendingImages.length) return;
  state.pendingImages.splice(index, 1);
  renderComposerAttachments();
}

export function renderComposerAttachments() {
  if (!els.composerAttachments) return;
  const images = state.pendingImages || [];
  if (images.length === 0) {
    els.composerAttachments.innerHTML = "";
    els.composerAttachments.hidden = true;
    return;
  }
  els.composerAttachments.hidden = false;
  els.composerAttachments.innerHTML = images
    .map((image, index) => {
      const sizeLabel = View.formatBytes(image.size || 0);
      const escName = View.escapeAttr(image.name || "image");
      const escUrl = View.escapeAttr(image.dataUrl);
      return `<div class="composer-attachment-card" title="${escName} · ${View.escapeAttr(sizeLabel)}">
        <button type="button" class="composer-attachment-image" data-image-group="composer" data-image-index="${index}" data-image-url="${escUrl}" data-image-name="${escName}" data-image-mime="${View.escapeAttr(image.mimeType)}">
          <img src="${escUrl}" alt="${escName}" />
        </button>
        <button type="button" class="composer-attachment-remove" data-attachment-remove="${index}" aria-label="Remove image">×</button>
      </div>`;
    })
    .join("");
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

export function restoreSidebarState() {
  const collapsed = localStorage.getItem("helixent.sidebarCollapsed") === "true";
  setSidebarCollapsed(collapsed);
}

export function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
}

export function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  els.toggleSidebar.setAttribute("aria-pressed", String(collapsed));
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  els.toggleSidebar.setAttribute("aria-label", label);
  els.toggleSidebar.title = label;
  localStorage.setItem("helixent.sidebarCollapsed", String(collapsed));
}

export function toggleTimeline() {
  setTimelineCollapsed(!document.body.classList.contains("timeline-collapsed"));
}

export function setTimelineCollapsed(collapsed) {
  document.body.classList.toggle("timeline-collapsed", collapsed);
  els.toggleTimeline.setAttribute("aria-pressed", String(collapsed));
  const label = collapsed ? "Expand timeline" : "Collapse timeline";
  els.toggleTimeline.setAttribute("aria-label", label);
  els.toggleTimeline.title = label;
  localStorage.setItem("helixent.timelineCollapsed", String(collapsed));
}

export function restoreTimelineState() {
  setTimelineCollapsed(localStorage.getItem("helixent.timelineCollapsed") === "true");
}

export async function resumeOrStartSession() {
  const savedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  if (savedSessionId) {
    try {
      const session = await api(`/api/sessions/${encodeURIComponent(savedSessionId)}`);
      applySessionSnapshot(session, { connect: true });
      return;
    } catch {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }
  await startSession();
}

export async function startSession() {
  const session = await api("/api/sessions", { method: "POST", body: {} });
  localStorage.setItem(SESSION_STORAGE_KEY, session.sessionId);
  applySessionSnapshot(session, { connect: true });
}

export function applySessionSnapshot(session, { connect = false } = {}) {
  state.session = session;
  state.commands = session.commands || [];
  state.tools = session.tools || [];
  state.messages = session.messages || [];
  state.events = [];
  state.traceRows = state.messages.map((message) => ({ type: "message", message }));
  state.progress = null;
  state.todos = [];
  state.pendingApproval = null;
  state.pendingQuestion = null;
  state.replaying = false;
  state.currentTraceId = session.sessionId;
  els.sessionMeta.textContent = session.model;
  els.workspaceCwd.textContent = formatCwdShort(session.cwd);
  setTopbarTitles(session.model, session.cwd);
  renderTools();
  renderCommands();
  renderRequest();
  renderOutput();
  renderTimeline();
  renderRunState();
  renderTodoPanel();
  if (connect) connectEvents(session.sessionId);
}

export function connectEvents(sessionId) {
  if (state.source) state.source.close();
  const source = new EventSource(`/api/sessions/${sessionId}/events`);
  state.source = source;
  source.addEventListener("open", () => renderRunState());
  for (const type of ["ready", "agent", "streaming_state", "message", "trace", "hook", "approval", "question", "todo_update", "commands", "command_executed", "error"]) {
    source.addEventListener(type, (event) => {
      if (!event.data) return;
      handleServerEvent(JSON.parse(event.data));
    });
  }
  source.onerror = () => {
    if (els.progressStatusLabel) els.progressStatusLabel.textContent = "SSE reconnecting";
    else els.progressStatus.textContent = "SSE reconnecting";
    els.progressStatus.dataset.status = "sse-reconnecting";
    els.progressStatus.title = "SSE reconnecting";
  };
}

export function handleServerEvent(event) {
  if (event.type === "ready") {
    state.commands = event.commands || [];
    renderCommands();
    return;
  }
  if (event.type === "agent") {
    handleAgentEvent(event.event);
    return;
  }
  if (event.type === "streaming_state") {
    state.streaming = !!event.streaming;
    if (!state.streaming) state.progress = null;
    renderRunState();
    renderOutput();
    return;
  }
  if (event.type === "message") {
    state.messages.push(event.message);
    appendTraceRow({ type: "message", message: outputMessageForTraceRow(event.message) });
    renderOutput();
    return;
  }
  if (event.type === "trace" || event.type === "hook") {
    state.events.push(event.event);
    appendTraceRow(event.event);
    if (event.event?.kind === "input_context") {
      syncPromptRuntime(event.event);
    }
    renderRequest();
    renderOutput();
    renderTimeline();
    renderRunState();
    renderTodoPanel();
    return;
  }
  if (event.type === "approval") {
    state.pendingApproval = event.request || null;
    renderOutput();
    return;
  }
  if (event.type === "question") {
    state.pendingQuestion = event.request || null;
    renderOutput();
    return;
  }
  if (event.type === "todo_update") {
    renderTodo(event.todos);
    return;
  }
  if (event.type === "commands") {
    state.commands = event.commands || [];
    renderCommands();
    return;
  }
  if (event.type === "command_executed") {
    if (event.name === "clear") {
      resetSessionUiState();
      flashStatus("Session cleared.");
      return;
    }
    if (event.name === "help") {
      flashStatus("Showing help.");
    } else if (event.reason === "cli-only") {
      flashStatus(`/${event.name} is only available in the terminal UI.`);
    }
    const at = new Date().toISOString();
    appendTraceRow({
      type: "command_executed",
      name: event.name,
      effect: event.effect ?? null,
      reason: event.reason ?? null,
      detail: event.detail ?? null,
      at,
    });
    state.events.push({
      id: `cmd:${at}:${event.name}`,
      kind: "command_executed",
      at,
      label: `/${event.name}`,
      data: {
        name: event.name,
        effect: event.effect ?? null,
        reason: event.reason ?? null,
        detail: event.detail ?? null,
      },
    });
    renderOutput();
    renderTimeline();
    return;
  }
  if (event.type === "error") {
    showError(event.message, { showInOutput: true });
  }
}

export function handleAgentEvent(event) {
  if (event.type !== "progress") return;
  state.progress = event;
  renderRunState();
}

export async function submitPrompt(event) {
  event.preventDefault();
  if (!state.session) return;
  if (state.streaming) {
    flashStatus("Agent is already running. Abort or wait first.");
    return;
  }
  const text = els.promptInput.value.trim();
  const images = state.pendingImages.slice();
  if (!text && images.length === 0) return;
  const slash = parseSlashInputClient(text, state.commands);
  if (slash.kind === "unknown") {
    flashStatus(`Unknown command: /${slash.name}`);
    return;
  }
  await flushPromptDraftFromEditor();
  els.promptInput.value = "";
  state.pendingImages = [];
  renderComposerAttachments();
  const body = images.length > 0 ? { text, images } : { text };
  await api(`/api/sessions/${state.session.sessionId}/messages`, {
    method: "POST",
    body,
  });
}

export function parseSlashInputClient(text, commands) {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) return { kind: "not-slash" };
  const body = trimmed.slice(1);
  const spaceIdx = body.indexOf(" ");
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
  if (!name) return { kind: "not-slash" };
  const match = (commands || []).find((c) => c.name?.toLowerCase() === name);
  if (!match) return { kind: "unknown", name, args };
  if (match.type === "skill") return { kind: "skill", name: match.name, args };
  return { kind: "builtin", name: match.name, args };
}

export async function abortRun() {
  if (!state.session) return;
  await api(`/api/sessions/${state.session.sessionId}/abort`, { method: "POST", body: {} });
}

export async function clearSession() {
  if (!state.session) return;
  await api(`/api/sessions/${state.session.sessionId}/clear`, { method: "POST", body: {} });
  resetSessionUiState();
}

export function resetSessionUiState() {
  state.messages = [];
  state.events = [];
  state.traceRows = [];
  state.progress = null;
  state.todos = [];
  state.pendingApproval = null;
  state.pendingQuestion = null;
  renderRequest();
  renderOutput();
  renderTimeline();
  renderRunState();
  renderTodoPanel();
}

export function appendTraceRow(row) {
  state.traceRows.push({ ...row, __clientReceivedAt: new Date().toISOString() });
}

export function outputMessageForTraceRow(message) {
  if (message?.role !== "assistant") return message;
  // Synthetic assistant messages (e.g. /help reply) are produced by the server
  // dispatcher rather than the model, so they have no paired model_output_block
  // trace. Render them as-is to avoid disappearing under __skipModelOutput.
  if (message.__synthetic) return message;
  const hasRenderableModelBlock = (message.content || []).some((block) => ["thinking", "text", "tool_use"].includes(block?.type));
  return hasRenderableModelBlock ? { ...message, __skipModelOutput: true } : message;
}
