// @ts-nocheck
import { state, els } from "./state.js";
import * as TraceExport from "../export.js";

export async function copyTextWithFallback(text) {
  if (
    typeof document !== "undefined"
    && document.hasFocus?.()
    && navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: "clipboard" };
    } catch {
      /* fall through */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "-9999px", opacity: "0" });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy") === true;
    ta.remove();
    if (ok) return { ok: true, via: "execCommand" };
  } catch {
    /* fall through */
  }
  return { ok: false };
}

const statusTokens = new WeakMap();
export function setStatusOn(el, message) {
  if (!el) return;
  const token = (statusTokens.get(el) || 0) + 1;
  statusTokens.set(el, token);
  el.textContent = message;
  window.setTimeout(() => {
    if (statusTokens.get(el) === token) el.textContent = "";
  }, 2500);
}

export async function copyTraceExport() {
  const text = buildSelectedTraceExport();
  if (!text.trim()) {
    setStatusOn(els.exportStatus, "Nothing to copy");
    return;
  }
  const r = await copyTextWithFallback(text);
  if (r.ok) {
    setStatusOn(els.exportStatus, "Copied");
    return;
  }
  downloadText(text, exportFileName());
  setStatusOn(els.exportStatus, "Clipboard blocked, downloaded");
}

export function downloadTraceExport() {
  const range = els.exportRange.value;
  const text = buildSelectedTraceExport();
  const extension = range === "raw" ? "jsonl" : "md";
  downloadText(text, exportFileName(extension));
  setStatusOn(els.exportStatus, "Exported");
}

export function buildSelectedTraceExport() {
  return TraceExport.buildTraceExport(state.traceRows, {
    range: els.exportRange.value || "last-1",
    session: state.session,
    traceId: state.currentTraceId,
  });
}

export function exportFileName(extension = els.exportRange.value === "raw" ? "jsonl" : "md") {
  const id = (state.currentTraceId || state.session?.sessionId || "trace").replace(/[^a-z0-9_-]/gi, "-");
  const range = (els.exportRange.value || "last-1").replace(/[^a-z0-9_-]/gi, "-");
  return `helixent-${id}-${range}.${extension}`;
}

export function downloadText(text, fileName) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function setExportStatus(message) {
  setStatusOn(els.exportStatus, message);
}
