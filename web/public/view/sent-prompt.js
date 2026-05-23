import { escapeAttr, escapeHtml } from "./utils.js";

// Splits the assembled prompt that was actually sent to the model into the editable base
// portion and the middleware-injected addition (currently `<skill_system>...</skill_system>`).
// Returns `{ baseText, addedText }`. If no addition is detected, `addedText` is empty.
export function splitAssembledPrompt(assembled = "", basePrompt = "") {
  const assembledStr = String(assembled || "");
  const baseStr = String(basePrompt || "");
  if (!assembledStr) return { baseText: baseStr, addedText: "" };
  if (baseStr && assembledStr.startsWith(baseStr)) {
    return { baseText: baseStr, addedText: assembledStr.slice(baseStr.length) };
  }
  // Fallback: detect <skill_system> block by tag.
  const tagStart = assembledStr.indexOf("<skill_system>");
  if (tagStart >= 0) {
    return {
      baseText: assembledStr.slice(0, tagStart).replace(/\s+$/, ""),
      addedText: assembledStr.slice(tagStart),
    };
  }
  return { baseText: assembledStr, addedText: "" };
}

/**
 * @param {{ assembled?: string; basePrompt?: string; versionName?: string|null; source?: string; at?: string|null }} [opts]
 */
export function renderSentPromptDialogHTML({ assembled = "", basePrompt = "", versionName = null, source = "runtime", at = null } = {}) {
  const { baseText, addedText } = splitAssembledPrompt(assembled, basePrompt);
  const meta = [
    source === "prompt_version" ? `Version · ${escapeHtml(versionName || "(unnamed)")}` : "Runtime base",
    at ? new Date(at).toLocaleTimeString() : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <header class="sent-prompt-dialog-header">
      <strong>System prompt sent to model</strong>
      <span class="sent-prompt-dialog-meta">${escapeHtml(meta)}</span>
    </header>
    <div class="sent-prompt-dialog-body">
      <pre class="sent-prompt-segment base">${escapeHtml(baseText)}</pre>
      ${
        addedText
          ? `<pre class="sent-prompt-segment added" title="Injected by middleware (skills, etc.) on each turn">${escapeHtml(addedText)}</pre>`
          : `<p class="sent-prompt-empty-added">No middleware additions on this turn.</p>`
      }
    </div>
    <footer class="sent-prompt-dialog-footer">
      <span class="sent-prompt-legend"><span class="legend-swatch base"></span>Editable base (Prompt Lab)</span>
      <span class="sent-prompt-legend"><span class="legend-swatch added"></span>Injected per-turn by middleware</span>
    </footer>
  `;
}

export function renderSentPromptIcon(sentPromptRowIndex = -1) {
  if (typeof sentPromptRowIndex !== "number" || sentPromptRowIndex < 0) return "";
  return `<button class="sent-prompt-icon" type="button" data-sent-prompt-row="${sentPromptRowIndex}" title="View system prompt sent to model" aria-label="View system prompt sent to model">◐</button>`;
}
