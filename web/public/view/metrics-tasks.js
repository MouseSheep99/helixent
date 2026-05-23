import { escapeAttr, escapeHtml, formatTokenCount, latestEvent, todoIcon } from "./utils.js";

export function renderMetricsHTML(events = [], progress, requestMetrics = []) {
  const usage = latestEvent(events, "token_usage")?.data?.usage || {};
  const toolCalls = events.filter((event) => event.kind === "tool_call_detected").length;
  const hooks = events.filter((event) => event.kind === "hook_triggered").length;
  const status = formatProgressStatus(progress);
  const metrics = [
    { label: "Status", value: status },
    { label: "Input", value: formatTokenCount(usage.input_tokens ?? usage.prompt_tokens) },
    { label: "Output", value: formatTokenCount(usage.output_tokens ?? usage.completion_tokens) },
    { label: "Tool calls", value: String(toolCalls) },
    { label: "Hooks", value: String(hooks) },
    ...requestMetrics,
  ];
  return metrics.map((metric) => renderMetricCard(metric.label, metric.value)).join("");
}

function renderMetricCard(label, value) {
  return `
    <div class="metric-card">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-value">${escapeHtml(value)}</span>
    </div>`;
}

export function renderTasksHTML(todos = [], events = []) {
  const visibleTodos = latestTodosFromEvents(events, todos);
  if (!visibleTodos.length) return `<div class="empty-state">No tasks yet.</div>`;
  const completed = visibleTodos.filter((todo) => todo.status === "completed").length;
  const pending = visibleTodos.filter((todo) => todo.status === "pending").length;
  const inProgress = visibleTodos.filter((todo) => todo.status === "in_progress").length;
  return `
    <div class="task-summary">${completed} completed${inProgress ? `, ${inProgress} in progress` : ""}${pending ? `, ${pending} pending` : ""}</div>
    <div class="task-list">
      ${visibleTodos
        .map(
          (todo) => `
          <div class="task-row ${escapeAttr(todo.status)}">
            <span class="task-icon">${todoIcon(todo.status)}</span>
            <span class="task-copy">
              <strong>${escapeHtml(todo.activeForm || todo.subject || todo.content || "Task")}</strong>
              <span>${escapeHtml(todo.content || todo.description || todo.subject || "")}</span>
            </span>
          </div>`,
        )
        .join("")}
    </div>`;
}

export function formatProgressStatus(progress, replaying = false) {
  if (replaying) return "Replay";
  if (!progress) return "Idle";
  if (progress.subtype === "tool") return `Tool · ${progress.name}`;
  return "Thinking";
}

export function latestProgressFromEvents(events = []) {
  const progress = latestEvent(events, "agent_progress")?.data?.progress;
  return progress || null;
}

export function latestTodosFromEvents(events = [], fallback = []) {
  const todos = latestEvent(events, "todo_update")?.data?.todos;
  return Array.isArray(todos) ? todos : fallback || [];
}
