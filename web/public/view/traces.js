import { escapeAttr, escapeHtml, formatBytes, formatTime } from "./utils.js";

export function replayEventsToState(items = []) {
  const messages = [];
  const events = [];
  for (const item of items) {
    if (item.type === "message" && item.message) {
      messages.push(item.message);
    } else if (item.kind) {
      events.push(item);
    }
  }
  return { messages, events };
}

export function renderTracesHTML(traces = [], query = "") {
  const q = query.toLowerCase();
  const visible = traces.filter((trace) => trace.id.toLowerCase().includes(q));
  if (!visible.length) return `<div class="empty-state">No traces yet.</div>`;
  return visible
    .map(
      (trace) => `
      <div class="list-item trace-item">
        <button class="trace-main" data-trace="${escapeAttr(trace.id)}" type="button">
          <span class="list-item-title"><span>${escapeHtml(trace.id)}</span></span>
          <span class="list-item-detail">${formatBytes(trace.size)} · ${formatTime(trace.modifiedTime)}</span>
        </button>
        <button class="ghost-button mini-button danger-mini" data-delete-trace="${escapeAttr(trace.id)}" type="button">Delete</button>
      </div>`,
    )
    .join("");
}
