// @ts-nocheck
import { state, els } from "./state.js";
import { buildTimelineExport, timelineExportFileName } from "../timeline-export-builder.js";
import { copyTextWithFallback, downloadText, setStatusOn } from "./trace-export.js";

function buildSelected() {
  return buildTimelineExport(state.traceRows, {
    range: els.timelineExportRange?.value || "last-1",
    format: els.timelineExportFormat?.value || "markdown",
    filter: els.timelineFilter?.value || "all",
    session: state.session,
    traceId: state.currentTraceId,
  });
}

const fmt = () => els.timelineExportFormat?.value || "markdown";
const rng = () => els.timelineExportRange?.value || "last-1";

export async function copyTimelineExport() {
  const text = buildSelected();
  if (!text.trim()) {
    setStatusOn(els.timelineExportStatus, "Nothing to copy");
    return;
  }
  const r = await copyTextWithFallback(text);
  if (r.ok) {
    setStatusOn(els.timelineExportStatus, "Copied");
    return;
  }
  downloadText(text, timelineExportFileName(fmt(), { traceId: state.currentTraceId, range: rng() }));
  setStatusOn(els.timelineExportStatus, "Clipboard blocked, downloaded");
}

export function downloadTimelineExport() {
  const text = buildSelected();
  if (!text.trim()) {
    setStatusOn(els.timelineExportStatus, "Nothing to export");
    return;
  }
  downloadText(text, timelineExportFileName(fmt(), { traceId: state.currentTraceId, range: rng() }));
  setStatusOn(els.timelineExportStatus, "Exported");
}
