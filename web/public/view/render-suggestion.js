// @ts-nocheck
import { escapeAttr, escapeHtml } from "./utils.js";

/**
 * Pure HTML template for the slash command suggestion popover. Renders the full
 * `<div role="listbox">` markup ready to be inlined into a host container.
 *
 * @param {{ items: SuggestionItem[], activeIndex: number, open: boolean }} state
 * @returns {string} HTML string. Empty string when `open` is false.
 */
export function renderSuggestionPopoverHTML(state) {
  if (!state || !state.open) return "";
  const items = Array.isArray(state.items) ? state.items : [];
  const activeIndex = typeof state.activeIndex === "number" ? state.activeIndex : 0;

  if (items.length === 0) {
    return `<div class="slash-popover slash-popover-empty" role="listbox" aria-label="Slash command suggestions">
      <div class="slash-popover-empty-text">No commands available</div>
    </div>`;
  }

  const builtins = items.filter((item) => item.type === "builtin");
  const skills = items.filter((item) => item.type === "skill");

  const sections = [];
  let runningIndex = 0;
  if (builtins.length > 0) {
    sections.push(renderSection("Built-in", builtins, runningIndex, activeIndex));
    runningIndex += builtins.length;
  }
  if (skills.length > 0) {
    sections.push(renderSection("Skills", skills, runningIndex, activeIndex));
  }

  return `<div class="slash-popover" role="listbox" aria-label="Slash command suggestions">
${sections.join("\n")}
  </div>`;
}

function renderSection(title, items, startIndex, activeIndex) {
  const rows = items
    .map((item, offset) => renderItem(item, startIndex + offset, activeIndex))
    .join("\n");
  return `  <div class="slash-popover-section">
    <div class="slash-popover-section-title">${escapeHtml(title)}</div>
    ${rows}
  </div>`;
}

function renderItem(item, index, activeIndex) {
  const isActive = index === activeIndex;
  const id = `slash-opt-${index}`;
  const effectLabel = item.effect === "local" ? "Local" : "Sent";
  const effectClass = item.effect === "local" ? "slash-popover-effect-local" : "slash-popover-effect-prompted";
  return `<div role="option"
       id="${id}"
       class="slash-popover-item${isActive ? " active" : ""}"
       aria-selected="${isActive ? "true" : "false"}"
       data-cmd="${escapeAttr(item.name)}"
       data-index="${index}">
    <span class="slash-popover-name">/${renderName(item.name, item.matchHighlight)}</span>
    <span class="slash-popover-effect ${effectClass}">${escapeHtml(effectLabel)}</span>
    <span class="slash-popover-desc">${escapeHtml(item.description ?? "")}</span>
  </div>`;
}

function renderName(name, highlight) {
  if (!Array.isArray(highlight) || highlight.length === 0) {
    return escapeHtml(name);
  }
  const [start, end] = highlight[0];
  const before = name.slice(0, start);
  const middle = name.slice(start, end);
  const after = name.slice(end);
  return `${escapeHtml(before)}<mark>${escapeHtml(middle)}</mark>${escapeHtml(after)}`;
}
