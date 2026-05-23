// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api, showError } from "./api.js";
import { applyEnabledTools } from "./tools.js";

export function syncPromptRuntime(traceEvent) {
  if (!state.session) return;
  state.session.promptState ||= { activeVersionId: null, runtime: null, versions: [] };
  // The trace event carries the **assembled** prompt (base + skill_system). We must not let it
  // overwrite `runtime.prompt`, which represents the editable **base** prompt prefilled from
  // `session.agent.prompt`. The assembled string is still available on each `input_context`
  // event for the per-turn ◐ dialog.
  const previous = state.session.promptState.runtime || {};
  state.session.promptState.runtime = {
    source: traceEvent.data?.source || "runtime",
    versionId: traceEvent.data?.versionId ?? null,
    name: traceEvent.data?.versionName ?? null,
    prompt: previous.prompt ?? "",
    messages: traceEvent.data?.messages || [],
    tools: traceEvent.data?.tools || [],
    requestedSkillName: traceEvent.data?.requestedSkillName ?? null,
  };
}

export async function savePromptVersion({ activate = false } = {}) {
  const editor = els.inputContext.querySelector("[data-prompt-editor]");
  if (!state.session || !editor) {
    showError("No prompt editor available.", { scope: "ui" });
    return;
  }
  const fallbackName = `Version ${(state.session.promptState?.versions?.length || 0) + 1}`;
  const inputName = editor.querySelector("[data-prompt-version-name]")?.value.trim();
  const name = (inputName || window.prompt("Name this version", fallbackName) || "").trim() || fallbackName;
  const snapshot = buildPromptSnapshotFromEditor(editor);
  if (!snapshot) return;
  const response = await api(`/api/sessions/${state.session.sessionId}/prompt/versions`, {
    method: "POST",
    body: {
      name,
      snapshot,
    },
  });
  state.session.promptState = response.promptState || state.session.promptState;
  if (activate && response.version?.id) {
    const activeResponse = await api(`/api/sessions/${state.session.sessionId}/prompt/active`, {
      method: "POST",
      body: { versionId: response.version.id },
    });
    state.session.promptState = activeResponse.promptState || state.session.promptState;
  }
  renderRequest();
}

export function buildPromptSnapshotFromEditor(editor) {
  const base = currentPromptSnapshot();
  if (!base) {
    showError("No prompt snapshot available.", { scope: "ui" });
    return null;
  }
  const prompt = editor.querySelector("[data-prompt-system]")?.value ?? base.prompt ?? "";
  const packageRoot = els.requestPackagePanel || document;
  const messagesRaw = packageRoot.querySelector("[data-prompt-messages]")?.value ?? "[]";
  let messages;
  try {
    messages = JSON.parse(messagesRaw);
  } catch (error) {
    showError(`Messages JSON is invalid: ${error.message || String(error)}`, { scope: "ui" });
    return null;
  }
  if (!Array.isArray(messages)) {
    showError("Messages JSON must be an array.", { scope: "ui" });
    return null;
  }
  const selectedToolIndexes = new Set(
    [...packageRoot.querySelectorAll("[data-prompt-tool-index]:checked")].map((input) => Number(input.dataset.promptToolIndex)),
  );
  const tools = selectedToolIndexes.size
    ? (base.tools || []).filter((_tool, index) => selectedToolIndexes.has(index))
    : (base.tools || []).filter((tool) => tool.enabled !== false);
  const requestedSkillName = editor.querySelector("[data-prompt-skill]")?.value.trim() || null;
  return {
    ...base,
    source: "prompt_version",
    versionId: null,
    name: null,
    prompt,
    messages,
    tools,
    requestedSkillName,
  };
}

export function currentPromptSnapshot() {
  const promptState = state.session?.promptState;
  if (!promptState) return buildDraftPromptSnapshot();
  if (promptState.activeVersionId) {
    const active = promptState.versions?.find((version) => version.id === promptState.activeVersionId);
    if (active) return active;
  }
  return promptState.runtime || buildDraftPromptSnapshot();
}

export async function resetPromptVersion() {
  if (!state.session) return;
  const response = await api(`/api/sessions/${state.session.sessionId}/prompt/active`, {
    method: "POST",
    body: { versionId: null },
  });
  state.session.promptState = response.promptState || state.session.promptState;
  renderRequest();
}

export async function activatePromptVersion(versionId) {
  if (!state.session || !versionId) return;
  const response = await api(`/api/sessions/${state.session.sessionId}/prompt/active`, {
    method: "POST",
    body: { versionId },
  });
  state.session.promptState = response.promptState || state.session.promptState;
  renderRequest();
}

export async function deletePromptVersion(versionId) {
  if (!state.session || !versionId) return;
  const ok = window.confirm("Delete this prompt version?");
  if (!ok) return;
  const response = await api(`/api/sessions/${state.session.sessionId}/prompt/versions/${encodeURIComponent(versionId)}`, {
    method: "DELETE",
    body: {},
  });
  state.session.promptState = response.promptState || state.session.promptState;
  renderRequest();
}

export function previewPromptQuery(messages = []) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return (message.content || [])
      .map((content) => View.contentToText(content))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 72);
  }
  return "";
}

export function renderRequest() {
  const rendered = View.renderRequestHTML(
    state.events,
    state.session?.promptState || null,
    state.replaying,
    buildDraftPromptSnapshot(),
  );
  state.requestMetrics = rendered.metrics || [];
  els.inputContext.innerHTML = rendered.body;
  if (els.requestPackagePanel) {
    els.requestPackagePanel.innerHTML = rendered.package || "";
  }
  renderPromptDiff(rendered.diff);
  renderAgentToolsBar();
  bindPromptRequestActions();
}

export function renderAgentToolsBar() {
  if (!els.agentToolsBar) return;
  if (state.replaying || !state.session) {
    els.agentToolsBar.setAttribute("hidden", "");
    els.agentToolsBar.innerHTML = "";
    return;
  }
  els.agentToolsBar.removeAttribute("hidden");
  els.agentToolsBar.innerHTML = View.renderAgentToolsBarHTML(state.tools || []);
  els.agentToolsBar.querySelectorAll("[data-agent-tool-disable]").forEach((button) => {
    button.addEventListener("click", () => toggleAgentTool(button.dataset.agentToolDisable, false));
  });
  els.agentToolsBar.querySelectorAll("[data-agent-tool-enable]").forEach((button) => {
    button.addEventListener("click", () => toggleAgentTool(button.dataset.agentToolEnable, true));
  });
}

export async function toggleAgentTool(name, enabled) {
  if (!state.session || !name) return;
  const tool = (state.tools || []).find((item) => item.name === name);
  if (tool) tool.enabled = enabled;
  await applyEnabledTools();
}

export function renderPromptDiff(html) {
  if (!els.promptDiffPanel) return;
  els.promptDiffPanel.innerHTML = html || View.renderPromptDiffPanelHTML();
}

export function buildDraftPromptSnapshot() {
  if (state.replaying || !state.session) return null;
  return {
    source: "runtime",
    versionId: null,
    name: null,
    prompt: "",
    messages: [],
    tools: (state.tools || []).filter((tool) => tool.enabled !== false),
    requestedSkillName: null,
  };
}

export function bindPromptRequestActions() {
  els.inputContext.querySelectorAll("[data-prompt-pin-version]").forEach((button) => {
    button.addEventListener("click", () => savePromptVersion({ activate: false }));
  });
  els.inputContext.querySelectorAll("[data-prompt-reset-runtime]").forEach((button) => {
    button.addEventListener("click", resetPromptDraft);
  });
  els.inputContext.querySelectorAll("[data-prompt-activate-version]").forEach((button) => {
    button.addEventListener("click", () => activatePromptVersion(button.dataset.promptActivateVersion));
  });
  els.inputContext.querySelectorAll("[data-prompt-delete-version]").forEach((button) => {
    button.addEventListener("click", () => deletePromptVersion(button.dataset.promptDeleteVersion));
  });
  els.inputContext.querySelectorAll("[data-prompt-system]").forEach((textarea) => {
    bindPromptDraftSync(textarea);
  });
}

export function bindPromptDraftSync(textarea) {
  textarea.addEventListener("input", () => {
    updatePromptStats(textarea);
    schedulePromptDraftSync(textarea.value);
  });
  textarea.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    document.execCommand(event.shiftKey ? "redo" : "undo");
    setTimeout(() => {
      updatePromptStats(textarea);
      schedulePromptDraftSync(textarea.value);
    }, 0);
  });
}

export function updatePromptStats(textarea) {
  const stats = View.computePromptStats(textarea.value);
  const target = els.inputContext.querySelector("[data-prompt-stats]");
  if (target) {
    target.textContent = `${stats.lines} lines · ${stats.chars} chars · ~${stats.tokens} tokens`;
  }
  const wrap = textarea.closest(".prompt-textarea-wrap");
  if (wrap) wrap.dataset.promptLineCount = String(stats.lines);
}

let promptDraftTimer = null;
let promptDraftLastSent = null;
export function schedulePromptDraftSync(value) {
  if (!state.session) return;
  setPromptSaveHint(true);
  setPromptSyncStatus("Pending changes…", { flash: true });
  if (promptDraftTimer) clearTimeout(promptDraftTimer);
  promptDraftTimer = setTimeout(() => {
    promptDraftTimer = null;
    void sendPromptDraft(value);
  }, 500);
}

export async function sendPromptDraft(value) {
  if (!state.session) return;
  if (promptDraftLastSent === value) {
    setPromptSaveHint(false);
    setPromptSyncStatusForState({ flash: false });
    return;
  }
  promptDraftLastSent = value;
  try {
    const response = await api(`/api/sessions/${state.session.sessionId}/prompt/draft`, {
      method: "PUT",
      body: { prompt: value },
    });
    if (response?.promptState) {
      state.session.promptState = response.promptState;
      setPromptSyncStatusForState({ flash: true });
    }
  } catch (error) {
    promptDraftLastSent = null;
    setPromptSyncStatus(`Auto-save failed: ${error.message || String(error)}`, { flash: true });
    showError(`Failed to save draft: ${error.message || String(error)}`, { scope: "ui" });
  } finally {
    setPromptSaveHint(false);
  }
}

export async function flushPromptDraftFromEditor() {
  const textarea = els.inputContext.querySelector("[data-prompt-system]");
  if (!textarea) return;
  if (promptDraftTimer) {
    clearTimeout(promptDraftTimer);
    promptDraftTimer = null;
  }
  await sendPromptDraft(textarea.value);
}

export function setPromptSaveHint(saving) {
  const hint = els.inputContext.querySelector("[data-prompt-save-hint]");
  if (!hint) return;
  hint.hidden = !saving;
  hint.textContent = saving ? "Saving…" : "Saved";
}

export function setPromptSyncStatusForState({ flash = false } = {}) {
  const updatedAt = state.session?.promptState?.draftUpdatedAt;
  const message = updatedAt
    ? `Auto-saved draft. Latest sync: ${formatPromptSyncTime(updatedAt)}`
    : "Auto-save ready. Latest sync: not yet saved.";
  setPromptSyncStatus(message, { flash });
}

export function setPromptSyncStatus(message, { flash = false } = {}) {
  const status = els.inputContext.querySelector("[data-prompt-sync-status]");
  if (!status) return;
  status.textContent = message;
  if (!flash) return;
  status.classList.remove("sync-flash");
  void status.offsetWidth;
  status.classList.add("sync-flash");
}

export function formatPromptSyncTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export async function resetPromptDraft() {
  if (!state.session) return;
  try {
    const response = await api(`/api/sessions/${state.session.sessionId}/prompt/draft`, {
      method: "DELETE",
    });
    if (response?.promptState) {
      state.session.promptState = response.promptState;
    }
    promptDraftLastSent = null;
    setPromptSyncStatusForState({ flash: true });
    renderRequest();
  } catch (error) {
    showError(`Failed to reset draft: ${error.message || String(error)}`, { scope: "ui" });
  }
}

export function setupPackageToggle() {
  if (!els.togglePackage || !els.requestPackagePanel) return;
  els.togglePackage.addEventListener("click", () => {
    const next = els.requestPackagePanel.hasAttribute("hidden");
    if (next) {
      els.requestPackagePanel.removeAttribute("hidden");
      els.togglePackage.setAttribute("aria-pressed", "true");
    } else {
      els.requestPackagePanel.setAttribute("hidden", "");
      els.togglePackage.setAttribute("aria-pressed", "false");
    }
  });
}
