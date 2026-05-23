// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api } from "./api.js";
import { currentPromptSnapshot } from "./prompt.js";
import { appendTraceRow } from "./session.js";

export function openMessageDialog(index) {
  const message = state.messages[index];
  if (!message) return;
  const images = View.extractImagesFromMessage(message);
  const text = (message.content || [])
    .filter((block) => block && block.type !== "image_url")
    .map(View.contentToText)
    .join("\n\n");
  els.messageDialogTitle.textContent = message.role === "tool" ? "Tool result" : `${message.role || "message"} message`;
  const stripHtml = images.length
    ? View.renderThumbnailStrip(images, { size: 120, group: `dialog-${index}` })
    : "";
  els.messageDialogBody.innerHTML = "";
  if (stripHtml) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-dialog-images";
    wrapper.innerHTML = stripHtml;
    els.messageDialogBody.appendChild(wrapper);
  }
  if (text) {
    const pre = document.createElement("pre");
    pre.className = "message-dialog-text";
    pre.textContent = text;
    els.messageDialogBody.appendChild(pre);
  }
  els.messageDialog.showModal();
}

export function renderOutput() {
  els.modelOutput.innerHTML = View.renderOutputHTML(state.traceRows, {
    pendingApproval: state.pendingApproval,
    pendingQuestion: state.pendingQuestion,
    streaming: state.streaming,
    progress: state.progress,
  });
  els.modelOutput.querySelectorAll("[data-message-index]").forEach((button) => {
    button.addEventListener("click", () => openMessageDialog(Number(button.dataset.messageIndex)));
  });
  els.modelOutput.querySelectorAll("[data-sent-prompt-row]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openSentPromptDialog(Number(button.dataset.sentPromptRow));
    });
  });
  els.modelOutput.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", () => sendApproval(button.dataset.approval));
  });
  els.modelOutput.querySelector("[data-submit-question]")?.addEventListener("click", () => {
    if (state.pendingQuestion) submitQuestion(state.pendingQuestion);
  });
}

export function openSentPromptDialog(rowIndex) {
  if (!els.sentPromptDialog || !Number.isFinite(rowIndex) || rowIndex < 0) return;
  const row = state.traceRows[rowIndex];
  if (!row || row.kind !== "input_context") return;
  const basePrompt = currentPromptSnapshot()?.prompt ?? "";
  els.sentPromptDialogBody.innerHTML = View.renderSentPromptDialogHTML({
    assembled: row.data?.prompt || "",
    basePrompt,
    versionName: row.data?.versionName || null,
    source: row.data?.source || "runtime",
    at: row.at || row.__clientReceivedAt || null,
  });
  els.sentPromptDialog.showModal();
}

export async function sendApproval(decision) {
  await api(`/api/sessions/${state.session.sessionId}/approval`, {
    method: "POST",
    body: { decision },
  });
}

export function renderTimeline() {
  els.timeline.innerHTML = View.renderTimelineHTML(state.events, els.timelineFilter.value);
}

export function renderRunState() {
  const status = View.formatProgressStatus(state.progress, state.replaying);
  els.progressStatus.textContent = status;
  els.progressStatus.dataset.status = status.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  els.runMetrics.innerHTML = View.renderMetricsHTML(state.events, state.progress, state.requestMetrics);
  const submitButton = els.composer?.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = !!state.streaming;
    submitButton.dataset.streaming = state.streaming ? "true" : "false";
    submitButton.textContent = state.streaming ? "Running…" : submitButton.dataset.idleLabel || submitButton.textContent || "Send";
    if (!submitButton.dataset.idleLabel && !state.streaming) {
      submitButton.dataset.idleLabel = submitButton.textContent;
    }
  }
}

export function renderTodoPanel() {
  if (!els.todoPanel) return;
  els.todoPanel.innerHTML = View.renderTasksHTML(state.todos, state.events);
}

export async function submitQuestion(request) {
  const checkedValues = (request.params.questions || []).map((_question, index) =>
    [...els.modelOutput.querySelectorAll(`[name="question-${index}"]:checked`)].map((input) => input.value),
  );
  const answers = View.buildQuestionAnswers(request.params.questions || [], checkedValues);
  await api(`/api/sessions/${state.session.sessionId}/question-answer`, {
    method: "POST",
    body: { result: { answers } },
  });
}

export function renderTodo(todos) {
  const next = todos || [];
  const prev = state.todos || [];
  state.todos = next;
  if (!View.shouldRecordTodoUpdate(prev, next)) {
    renderRunState();
    renderTodoPanel();
    return;
  }
  const event = View.createTodoTraceEvent(state.todos);
  state.events.push(event);
  appendTraceRow(event);
  renderTimeline();
  renderRunState();
  renderTodoPanel();
}
