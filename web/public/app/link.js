// @ts-nocheck
// UI-2: chat-thread ↔ timeline 双向高亮联动 controller。
// 单一锚点：data-node-id（强高亮目标）+ data-node-scope（同 scope 微亮）。
import { els } from "./state.js";

let activeKey = null;
let chipEl = null;

export function initOutputTimelineLink() {
  const output = els.modelOutput;
  const timeline = els.timeline;
  if (!output || !timeline) return;
  output.addEventListener("click", (e) => onClick(e, "output"));
  timeline.addEventListener("click", (e) => onClick(e, "timeline"));
  chipEl = document.getElementById("linkHighlightChip");
  if (chipEl) {
    chipEl.addEventListener("click", () => clearHighlight());
  }
}

function onClick(e, side) {
  const node = e.target.closest("[data-node-id]");
  if (!node) return;
  const nodeId = node.dataset.nodeId;
  if (!nodeId) return;
  applyHighlight(nodeId, side);
}

function applyHighlight(nodeId, originSide) {
  if (activeKey === nodeId) {
    clearHighlight();
    return;
  }
  document.querySelectorAll(".is-link-highlight, .is-link-scope").forEach((el) => {
    el.classList.remove("is-link-highlight", "is-link-scope");
  });
  activeKey = nodeId;
  updateChip();
  const escaped = cssEscape(nodeId);
  // Strong highlight: every element with the matching data-node-id (cross-pane).
  document.querySelectorAll(`[data-node-id="${escaped}"]`).forEach((el) => {
    el.classList.add("is-link-highlight");
    if (originSide === "output") openAncestorDetails(el);
    scrollIntoViewSoft(el);
  });
  // Soft highlight: every element whose data-node-scope matches this nodeId
  // (children of the clicked node within the same logical scope).
  document.querySelectorAll(`[data-node-scope="${escaped}"]`).forEach((el) => {
    el.classList.add("is-link-scope");
  });
}

function clearHighlight() {
  document.querySelectorAll(".is-link-highlight, .is-link-scope").forEach((el) => {
    el.classList.remove("is-link-highlight", "is-link-scope");
  });
  activeKey = null;
  updateChip();
}

function updateChip() {
  if (!chipEl) return;
  if (!activeKey) {
    chipEl.hidden = true;
    chipEl.textContent = "";
    return;
  }
  chipEl.hidden = false;
  chipEl.textContent = `🔗 ${formatChipLabel(activeKey)} ✕`;
  chipEl.title = "Click to clear linked highlight";
}

function formatChipLabel(nodeId) {
  const [kind, ...rest] = nodeId.split(":");
  const tail = rest.join(":");
  if (kind === "tool") return `tool ${truncateMiddle(tail)}`;
  if (kind === "step") return `step ${rest[rest.length - 1] || ""}`;
  if (kind === "agent") return `agent ${rest[1] || ""}`;
  if (kind === "run") return `run ${truncateMiddle(tail)}`;
  if (kind === "phase") return `phase ${rest[rest.length - 1] || ""}`;
  if (kind === "message") return `msg ${rest[1] || ""}`;
  if (kind === "thinking") return `thinking ${tail}`;
  if (kind === "response") return `response ${tail}`;
  if (kind === "error") return `error ${truncateMiddle(tail)}`;
  if (kind === "event") return `event ${truncateMiddle(tail)}`;
  return nodeId;
}

function truncateMiddle(s, max = 12) {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 4)}…${s.slice(-3)}`;
}

function openAncestorDetails(el) {
  let p = el.closest("details");
  while (p) {
    p.open = true;
    p = p.parentElement?.closest("details");
  }
}

function scrollIntoViewSoft(el) {
  try {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    // ignore: jsdom / older browsers
  }
}

function cssEscape(value) {
  if (typeof window !== "undefined" && window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}
