export function latestEvent(events = [], kind) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === kind) return events[i];
  }
  return null;
}

export function contentToText(content) {
  if (content.type === "text") return content.text || "";
  if (content.type === "thinking") return `[thinking] ${content.thinking || ""}`;
  if (content.type === "tool_use") return `[tool_use ${content.name}] ${JSON.stringify(content.input || {})}`;
  if (content.type === "tool_result") return `[tool_result ${content.tool_use_id}] ${content.content}`;
  if (content.type === "image_url") return "[image]";
  return JSON.stringify(content);
}

export function chip(text) {
  return `<span class="chip">${escapeHtml(text)}</span>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

export function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTokenCount(value) {
  if (typeof value !== "number") return "—";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function todoIcon(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "◐";
  if (status === "cancelled") return "✕";
  return "○";
}
