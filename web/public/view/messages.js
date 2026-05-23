import { renderInteractiveOutputCard, renderSystemOutputCard } from "./output-cards.js";
import { contentToText, escapeAttr, escapeHtml } from "./utils.js";

export function renderMessagesHTML(messages = []) {
  if (!messages.length) return `<div class="empty-state">No messages yet.</div>`;
  return `<div class="message-stack">${messages.map((message, index) => renderMessageCard(message, index)).join("")}</div>`;
}

export function renderMessageCard(message, index = 0) {
  const text = message.content?.map(contentToText).join("\n\n") || "";
  const symbol = message.role === "user" ? "❯" : message.role === "tool" ? "⌘" : "◌";
  const isProjectContext = message.role === "user" && text.includes("The `AGENTS.md` file has been automatically loaded");
  const detail = isProjectContext ? "Project Context · AGENTS.md" : message.role === "tool" ? "Tool result" : message.role;
  const preview = summarizeMessageText(text);
  const meta = [message.role || "message", `${Array.isArray(message.content) ? message.content.length : 0} block${Array.isArray(message.content) && message.content.length === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  return `
    <article class="message-card ${escapeAttr(message.role)} ${isProjectContext ? "project-context" : ""}">
      <button class="message-card-button" type="button" data-message-index="${index}">
        <span class="message-card-leading">
          <span class="message-avatar">${symbol}</span>
          <span class="message-card-copy">
            <span class="role-label">${escapeHtml(detail)}</span>
            <span class="message-meta">${escapeHtml(meta)}</span>
          </span>
        </span>
        <span class="message-preview">${escapeHtml(preview)}</span>
        <span class="message-open">Inspect</span>
      </button>
    </article>`;
}

export function summarizeMessageText(text = "") {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "empty message";
  return compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
}

export function renderBlock(block, options = {}) {
  const sentPromptRowIndex = options.sentPromptRowIndex ?? -1;
  if (block.type === "thinking") {
    return renderSystemOutputCard({
      tone: "thinking",
      label: "Thinking",
      subtitle: "Live reasoning trace from the model",
      chipLabel: "internal",
      body: `<div class="plain-text">${escapeHtml(block.thinking || "")}</div>`,
      sentPromptRowIndex,
    });
  }
  if (block.type === "text") {
    return renderSystemOutputCard({
      tone: "text",
      label: "Response",
      subtitle: "Assistant answer ready for review",
      chipLabel: "assistant",
      chipClass: "success-chip",
      body: `<div class="plain-text">${escapeHtml(block.text || "")}</div>`,
      sentPromptRowIndex,
    });
  }
  if (block.type === "tool_use") {
    return renderSystemOutputCard({
      tone: "tool_use",
      label: `Tool request · ${escapeHtml(block.name || "")}`,
      subtitle: "Model selected a tool invocation",
      chipLabel: "tool call",
      chipClass: "warning-chip",
      body: `<pre>${escapeHtml(JSON.stringify(block.input || {}, null, 2))}</pre>`,
    });
  }
  return renderSystemOutputCard({
    tone: "usage",
    label: escapeHtml(block.type || "block"),
    subtitle: "Unclassified model output block",
    body: `<pre>${escapeHtml(JSON.stringify(block, null, 2))}</pre>`,
  });
}

export function renderAssistantMessageBlock(block, index, options = {}) {
  if (!block || typeof block !== "object") return "";
  const sentPromptRowIndex = options.sentPromptRowIndex ?? -1;
  if (block.type === "thinking") {
    if (!String(block.thinking || "").trim()) return "";
    return renderInteractiveOutputCard({
      tone: "thinking",
      index,
      label: "Thinking",
      subtitle: "Live reasoning trace from the model",
      chipLabel: "internal",
      body: `<div class="plain-text">${escapeHtml(block.thinking || "")}</div>`,
      sentPromptRowIndex,
    });
  }
  if (block.type === "text") {
    if (!String(block.text || "").trim()) return "";
    return renderInteractiveOutputCard({
      tone: "text",
      index,
      label: "Response",
      subtitle: "Assistant answer ready for review",
      chipLabel: "assistant",
      chipClass: "success-chip",
      body: `<div class="plain-text">${escapeHtml(block.text || "")}</div>`,
      sentPromptRowIndex,
    });
  }
  if (block.type === "tool_use") {
    return renderInteractiveOutputCard({
      tone: "tool_use",
      index,
      label: `Tool request · ${escapeHtml(block.name || "")}`,
      subtitle: "Model selected a tool invocation",
      chipLabel: "tool call",
      chipClass: "warning-chip",
      body: `<pre>${escapeHtml(JSON.stringify(block.input || {}, null, 2))}</pre>`,
      sentPromptRowIndex,
    });
  }
  return renderInteractiveOutputCard({
    tone: "usage",
    index,
    label: escapeHtml(block.type || "block"),
    subtitle: "Unclassified model output block",
    body: `<pre>${escapeHtml(JSON.stringify(block, null, 2))}</pre>`,
    sentPromptRowIndex,
  });
}
