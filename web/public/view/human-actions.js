import { escapeAttr, escapeHtml } from "./utils.js";

export function renderApprovalHTML(request) {
  if (!request) return `<div class="empty-state">No pending approval or question.</div>`;
  return renderApprovalContent(request);
}

export function renderApprovalContent(request) {
  return `
    <div class="tui-line"><span class="tui-dot muted">⏺</span><span class="role-label">Approval requested</span></div>
    <div class="human-action-copy">Protected tool execution is paused until you review the request.</div>
    <pre>${escapeHtml(JSON.stringify(request.toolUse, null, 2))}</pre>
    <div class="choice-row">
      <button type="button" data-approval="allow_once">Allow once</button>
      <button type="button" data-approval="allow_always_project">Always allow</button>
      <button type="button" class="danger-button" data-approval="deny">Deny</button>
    </div>`;
}

export function renderQuestionHTML(request) {
  if (!request) return `<div class="empty-state">No pending approval or question.</div>`;
  return renderQuestionContent(request);
}

export function renderQuestionContent(request) {
  return `
    <div class="tui-line"><span class="tui-dot muted">⏺</span><span class="role-label">Question requested</span></div>
    <div class="human-action-copy">The agent needs structured input before it can continue the run.</div>
    <div class="question-stack">${(request.params.questions || []).map(renderQuestionItem).join("")}</div>
    <div class="choice-row"><button type="button" data-submit-question>Submit answer</button></div>`;
}

export function renderQuestionItem(question, index) {
  return `
    <section class="trace-card question-card" data-question="${index}">
      <div class="card-title">${escapeHtml(question.header)}</div>
      <p>${escapeHtml(question.question)}</p>
      <div class="question-options">
        ${(question.options || [])
          .map(
            (option, optionIndex) => `
            <label class="tool-toggle question-option">
              <input
                type="${question.multi_select ? "checkbox" : "radio"}"
                name="question-${index}"
                value="${escapeAttr(option.label)}"
                ${!question.multi_select && optionIndex === 0 ? "checked" : ""}
              />
              <span>${escapeHtml(option.label)} · ${escapeHtml(option.description)}</span>
            </label>`,
          )
          .join("")}
      </div>
    </section>`;
}

export function buildQuestionAnswers(questions = [], checkedValuesByQuestion = []) {
  return questions.map((question, index) => {
    const checked = checkedValuesByQuestion[index] || [];
    return { question_index: index, selected_labels: checked.length ? checked : [question.options[0].label] };
  });
}

export function createTodoTraceEvent(todos = []) {
  const summary = todos.map((todo) => `${todo.status}: ${todo.content}`).join("\n");
  return {
    id: crypto.randomUUID(),
    kind: "todo_update",
    at: new Date().toISOString(),
    label: "Todo panel updated",
    data: { todos, summary },
  };
}

// BF-1: 仅在状态发生有意义的变化时记录 todo_update。
// 上一次和这一次都是空 → 视为冗余，不记录。
// 任一非空 → 记录（包括 3 → 0 这种"主动清空"，因为是有效状态变更）。
export function shouldRecordTodoUpdate(prev = [], next = []) {
  return (prev?.length ?? 0) > 0 || (next?.length ?? 0) > 0;
}
