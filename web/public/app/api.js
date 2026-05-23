// @ts-nocheck
import { state, els } from "./state.js";
import { appendTraceRow } from "./session.js";
import { renderTimeline, renderRunState, renderOutput } from "./output.js";

export async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(path, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

export function showError(message, options = {}) {
  const event = {
    id: crypto.randomUUID(),
    kind: "error",
    at: new Date().toISOString(),
    label: message,
    data: { message, showInOutput: options.showInOutput !== false },
  };
  state.events.push(event);
  appendTraceRow(event);
  renderTimeline();
  renderRunState();
  if (options.showInOutput !== false) renderOutput();
}

export function flashStatus(message) {
  if (!els.progressStatus) return;
  els.progressStatus.textContent = message;
  els.progressStatus.classList.add("status-flash");
  setTimeout(() => {
    els.progressStatus.classList.remove("status-flash");
  }, 1800);
}
