// @ts-nocheck
import { state, els } from "./state.js";
import * as TraceExport from "../export.js";

export async function copyTraceExport() {
  const text = buildSelectedTraceExport();
  if (!text.trim()) {
    setExportStatus("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setExportStatus("Copied");
  } catch {
    downloadText(text, exportFileName());
    setExportStatus("Clipboard blocked, downloaded");
  }
}

export function downloadTraceExport() {
  const range = els.exportRange.value;
  const text = buildSelectedTraceExport();
  const extension = range === "raw" ? "jsonl" : "md";
  downloadText(text, exportFileName(extension));
  setExportStatus("Exported");
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
  els.exportStatus.textContent = message;
  window.setTimeout(() => {
    if (els.exportStatus.textContent === message) els.exportStatus.textContent = "";
  }, 2500);
}
