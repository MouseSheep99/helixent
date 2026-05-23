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
  const { source = "server", scope = "trace", showInOutput = true, autoDismissMs } = options;
  if (scope === "ui") {
    showNotice(message, { tone: "error", autoDismissMs });
    return;
  }
  const event = {
    id: crypto.randomUUID(),
    kind: "error",
    at: new Date().toISOString(),
    label: message,
    data: { message, source, scope, showInOutput },
  };
  state.events.push(event);
  appendTraceRow(event);
  renderTimeline();
  renderRunState();
  if (showInOutput) renderOutput();
}

export function showNotice(message, options = {}) {
  const { tone = "info", autoDismissMs = 5000 } = options;
  const container = els.appNotices;
  if (!container) {
    // Fallback: still surface to console so the message is not silently lost.
    // eslint-disable-next-line no-console
    console.warn("[notice]", message);
    return;
  }
  const item = document.createElement("div");
  item.className = "app-notice";
  item.dataset.tone = tone;
  item.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "app-notice-text";
  text.textContent = String(message ?? "");
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "app-notice-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "×";
  const dismiss = () => {
    if (item.isConnected) item.remove();
  };
  closeBtn.addEventListener("click", dismiss);
  item.appendChild(text);
  item.appendChild(closeBtn);
  container.appendChild(item);
  if (autoDismissMs > 0) {
    setTimeout(dismiss, autoDismissMs);
  }
}

export function flashStatus(message) {
  if (!els.progressStatus) return;
  els.progressStatus.textContent = message;
  els.progressStatus.classList.add("status-flash");
  setTimeout(() => {
    els.progressStatus.classList.remove("status-flash");
  }, 1800);
}
