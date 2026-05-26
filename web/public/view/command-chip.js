// @ts-nocheck
import { escapeAttr, escapeHtml } from "./utils.js";

/**
 * Render the textarea-adjacent "command chip" hint row.
 *
 * @param {{ kind: "not-slash" | "builtin" | "skill" | "unknown",
 *          name?: string,
 *          effect?: "local" | "prompted" } | null} parseResult
 * @returns {string} HTML for the chip row, or empty string when nothing should
 *                   be shown (e.g. plain text input).
 */
export function renderCommandChipHTML(parseResult) {
  if (!parseResult || parseResult.kind === "not-slash") return "";
  const kind = parseResult.kind;
  const name = typeof parseResult.name === "string" ? parseResult.name : "";

  if (kind === "unknown") {
    return chipHTML({
      name,
      effectClass: "composer-chip-effect-unknown",
      label: `Unknown · sent as plain text`,
      kind: "unknown",
    });
  }

  if (kind === "skill") {
    return chipHTML({
      name,
      effectClass: "composer-chip-effect-prompted",
      label: "Sent to model · skill",
      kind: "skill",
    });
  }

  // builtin
  const effect = parseResult.effect === "prompted" ? "prompted" : "local";
  if (effect === "local") {
    return chipHTML({
      name,
      effectClass: "composer-chip-effect-local",
      label: "Local · won't reach the model",
      kind: "builtin",
    });
  }
  return chipHTML({
    name,
    effectClass: "composer-chip-effect-prompted",
    label: "Sent to model",
    kind: "builtin",
  });
}

function chipHTML({ name, effectClass, label, kind }) {
  return `<div class="composer-chip composer-chip-${kind}" data-kind="${escapeAttr(kind)}">
    <span class="composer-chip-name">/${escapeHtml(name)}</span>
    <span class="composer-chip-effect ${effectClass}">${escapeHtml(label)}</span>
    <button type="button" class="composer-chip-remove" aria-label="Clear command">×</button>
  </div>`;
}
