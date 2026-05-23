import { buildAgentOutputGraph, renderAgentOutputGraph } from "./agent-output-graph.js";
import { renderApprovalContent, renderQuestionContent } from "./human-actions.js";
import { extractImagesFromMessage, renderThumbnailStrip } from "./images.js";
import { renderAssistantMessageBlock, summarizeMessageText } from "./messages.js";
import { renderSentPromptIcon } from "./sent-prompt.js";
import { contentToText, escapeAttr, escapeHtml } from "./utils.js";

export function renderOutputHTML(rowsOrEvents = [], legacyMessagesOrOptions, options = {}) {
  // Backwards-compatible signature:
  //  renderOutputHTML(traceRows)             — preferred, ordered chronologically
  //  renderOutputHTML(events, messages)      — legacy split form
  //  renderOutputHTML(traceRows, options)    — preferred with pending human actions
  const hasLegacyMessages = Array.isArray(legacyMessagesOrOptions);
  const rows = hasLegacyMessages ? mergeLegacyOutputRows(rowsOrEvents, legacyMessagesOrOptions) : rowsOrEvents;
  const outputOptions = hasLegacyMessages ? options : legacyMessagesOrOptions || {};
  const graph = buildAgentOutputGraph(rows, outputOptions);
  const cards = graph.runs.length ? [renderAgentOutputGraph(graph, outputOptions)] : [];
  cards.push(...renderPendingHumanActionCards(outputOptions));
  if (cards.length) return `<div class="output-stack">${cards.join("")}</div>`;
  if (outputOptions.streaming) {
    return `<div class="output-stack">${renderThinkingPlaceholderCard(outputOptions.progress)}</div>`;
  }
  return `<div class="empty-state">No model output or pending human action yet.</div>`;
}

export function renderThinkingPlaceholderCard(progress) {
  const isTool = progress && progress.subtype === "tool";
  const subtitle = isTool && progress.name
    ? `Tool · ${escapeHtml(String(progress.name))}`
    : "Waiting for model response";
  return `
    <article class="output-card thinking-placeholder" data-tone="thinking">
      <header class="output-card-head">
        <span class="output-card-label">Thinking…</span>
        <span class="output-card-chip" data-tone="thinking">streaming</span>
      </header>
      <p class="output-card-subtitle">${subtitle}</p>
      <div class="thinking-placeholder-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </article>
  `;
}

export function mergeLegacyOutputRows(events = [], messages = []) {
  const rows = [...events];
  for (const message of messages) {
    rows.push({ type: "message", message });
  }
  return rows;
}

export function renderMessageOutputCard(message, index, options = {}) {
  const role = message.role;
  if (role === "tool") {
    return renderInteractiveOutputCard({
      tone: "tool_result",
      index,
      label: "Tool result",
      subtitle: "Structured tool payload returned to the agent",
      chipLabel: "tool",
      body: `<pre>${escapeHtml(JSON.stringify(message.content, null, 2))}</pre>`,
    });
  }
  if (role === "user") {
    const text = (message.content || [])
      .filter((block) => block && block.type !== "image_url")
      .map(contentToText)
      .join("\n\n");
    const isProjectContext = text.includes("The `AGENTS.md` file has been automatically loaded");
    if (isProjectContext) {
      return renderInteractiveOutputCard({
        tone: "user project-context",
        index,
        label: "Project context",
        subtitle: "Bootstrapped guidance from AGENTS.md",
        chipLabel: "context",
        body: `<div class="plain-text">${escapeHtml(summarizeMessageText(text))}</div>`,
      });
    }
    const images = extractImagesFromMessage(message);
    return renderUserQueryBubble({ index, text, images });
  }
  if (role === "assistant") {
    if (message.__skipModelOutput) return "";
    const blocks = Array.isArray(message.content) ? message.content : [];
    const cards = blocks
      .map((block) => renderAssistantMessageBlock(block, index, options))
      .filter(Boolean);
    return cards.join("");
  }
  return "";
}

export function renderPendingHumanActionCards({ pendingApproval = null, pendingQuestion = null } = {}) {
  return [renderApprovalOutputCard(pendingApproval), renderQuestionOutputCard(pendingQuestion)].filter(Boolean);
}

export function renderUserQueryBubble({ index, text = "", images = [] }) {
  const stripHtml = images && images.length
    ? renderThumbnailStrip(images, { size: 96, group: `bubble-${index}` })
    : "";
  const textHtml = text ? `<div class="user-query-bubble-text">${escapeHtml(text)}</div>` : "";
  const imagesHtml = stripHtml ? `<div class="user-query-bubble-images">${stripHtml}</div>` : "";
  return `<div class="user-query-bubble" role="button" tabindex="0" data-message-index="${index}">${imagesHtml}${textHtml}</div>`;
}

export function renderInteractiveOutputCard({ tone = "usage", index, label, subtitle = "", chipLabel = "", chipClass = "subtle-chip", body = "", sentPromptRowIndex = -1 }) {
  return `
    <article class="output-card ${escapeAttr(tone)}">
      <button class="output-card-button" type="button" data-message-index="${index}">
        ${renderOutputCardInner({ label, subtitle, chipLabel, chipClass, body })}
      </button>
      ${renderSentPromptIcon(sentPromptRowIndex)}
    </article>`;
}

export function renderSystemOutputCard({ tone = "usage", label, subtitle = "", chipLabel = "", chipClass = "subtle-chip", body = "", sentPromptRowIndex = -1 }) {
  return `
    <article class="output-card ${escapeAttr(tone)}">
      ${renderOutputCardInner({ label, subtitle, chipLabel, chipClass, body })}
      ${renderSentPromptIcon(sentPromptRowIndex)}
    </article>`;
}

export function renderOutputCardInner({ label, subtitle = "", chipLabel = "", chipClass = "subtle-chip", body = "" }) {
  return `
    <div class="output-card-header">
      <div>
        <div class="block-label">${label}</div>
        ${subtitle ? `<div class="output-card-subtitle">${escapeHtml(subtitle)}</div>` : ""}
      </div>
      ${chipLabel ? `<span class="chip ${escapeAttr(chipClass)}">${escapeHtml(chipLabel)}</span>` : ""}
    </div>
    ${body}`;
}

export function renderApprovalOutputCard(request) {
  if (!request) return "";
  return `
    <article class="output-card human_action approval">
      ${renderApprovalContent(request)}
    </article>`;
}

export function renderQuestionOutputCard(request) {
  if (!request) return "";
  return `
    <article class="output-card human_action question">
      ${renderQuestionContent(request)}
    </article>`;
}
