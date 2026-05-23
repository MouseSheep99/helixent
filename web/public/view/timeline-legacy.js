import { extractImagesFromEvent, renderThumbnailStrip, sanitizeImagesForDebugDump } from "./images.js";
import { escapeAttr, escapeHtml, formatTime } from "./utils.js";

export function compactTimelineEvents(events = []) {
  const compacted = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (canMergeTimelineEvents(previous, event)) {
      previous.count = (previous.count || 1) + 1;
      previous.lastAt = event.at;
      previous.data = {
        ...(previous.data || {}),
        count: previous.count,
        firstAt: previous.firstAt || previous.at,
        lastAt: event.at,
        lastProgress: event.data?.progress,
      };
      continue;
    }
    compacted.push({ ...event });
  }
  return compacted;
}

function canMergeTimelineEvents(previous, event) {
  if (!previous || previous.kind !== "agent_progress" || event.kind !== "agent_progress") return false;
  const prevProgress = previous.data?.lastProgress || previous.data?.progress || {};
  const nextProgress = event.data?.progress || {};
  return prevProgress.subtype === nextProgress.subtype && prevProgress.name === nextProgress.name;
}

export function formatTimelineMeta(event) {
  const count = event.count || event.data?.count;
  const time = count ? `${formatTime(event.at)} - ${formatTime(event.lastAt || event.data?.lastAt)}` : formatTime(event.at);
  return `${friendlyTimelineKind(event.kind)}${count ? ` x${count}` : ""} · ${time}`;
}

export function renderTimelineItem(event) {
  const badge = timelineBadge(event);
  const safeData = sanitizeImagesForDebugDump(event.data || {});
  const images = extractImagesFromEvent(event);
  const stripHtml = images.length
    ? `<div class="timeline-event-images">${renderThumbnailStrip(images, { size: 56, group: `timeline-${event.id || event.at}` })}</div>`
    : "";
  return `
    <details class="timeline-item ${escapeAttr(event.kind)}">
      <summary>
        <span class="timeline-icon">${escapeHtml(timelineIcon(event.kind))}</span>
        <span class="timeline-summary-copy">
          <span class="timeline-summary-topline">
            <span class="timeline-title">${escapeHtml(event.label || friendlyTimelineKind(event.kind))}</span>
            ${badge ? `<span class="timeline-badge">${escapeHtml(badge)}</span>` : ""}
          </span>
          <span class="timeline-meta">${escapeHtml(formatTimelineMeta(event))}</span>
        </span>
      </summary>
      <pre>${escapeHtml(JSON.stringify(safeData, null, 2))}</pre>
      ${stripHtml}
    </details>`;
}

export function timelineBadge(event) {
  const count = event.count || event.data?.count;
  if (event.kind === "tool_call_detected") return event.data?.toolUse?.name || "tool";
  if (event.kind === "tool_execution_started" || event.kind === "tool_execution_completed") return event.data?.toolName || event.data?.name || "tool";
  if (event.kind === "approval_requested") return "approval";
  if (event.kind === "question_requested") return `${event.data?.questions?.length || event.params?.questions?.length || 1} question`;
  if (event.kind === "todo_update") return `${event.data?.todos?.length || 0} todos`;
  if (event.kind === "agent_progress") return count ? `${count} updates` : event.data?.progress?.name || event.data?.progress?.subtype || "progress";
  if (event.kind === "input_context") {
    const imageCount = extractImagesFromEvent(event).length;
    if (imageCount > 0) return `${imageCount} img`;
  }
  return "";
}

export function friendlyTimelineKind(kind = "") {
  return kind.replaceAll("_", " ");
}

export function timelineIcon(kind = "") {
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(kind)) return "◎";
  if (["tool_call_detected", "tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(kind)) return "⌘";
  if (["hook_triggered", "agent_progress", "input_context", "model_output_block", "token_usage"].includes(kind)) return "◌";
  if (["todo_update", "session_created", "session_cleared", "session_aborted"].includes(kind)) return "◧";
  if (kind === "error") return "!";
  return "•";
}

export function shouldShowTimelineEvent(event, filter = "all") {
  if (filter === "all") return !["input_context", "model_output_block"].includes(event.kind);
  if (filter === "hooks") return event.kind === "hook_triggered";
  if (filter === "model") return ["input_context", "model_output_block", "token_usage", "agent_progress", "prompt_version_applied"].includes(event.kind);
  if (filter === "tools") {
    return [
      "skill_loaded",
      "tool_call_detected",
      "tool_execution_started",
      "tool_execution_completed",
      "tool_disabled",
      "agent_progress",
    ].includes(event.kind);
  }
  if (filter === "human") {
    return ["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(event.kind);
  }
  if (filter === "session") {
    return [
      "session_created",
      "session_cleared",
      "session_aborted",
      "prompt_version_saved",
      "prompt_version_activated",
      "prompt_version_deleted",
      "tool_enabled_updated",
      "skills_inventory",
      "skill_system_injected",
      "skill_loaded",
      "todo_update",
      "error",
    ].includes(event.kind);
  }
  return true;
}
