// @ts-nocheck
import { selectRowsForRange, buildRawJsonl } from "./export.js";
import { buildTimelineGraph } from "./view/timeline.js";
import { shouldShowTimelineEvent } from "./view/timeline-legacy.js";

const FORMAT_LABELS = {
  markdown: "Markdown",
  csv: "CSV",
  jsonl: "Raw JSONL",
};

const RANGE_LABELS = {
  "last-1": "Last 1 run",
  "last-3": "Last 3 runs",
  full: "Full session",
};

const PHASE_TITLES = {
  user_input: "User Input",
  prompt_phase: "Prompt",
  skills: "Skills",
  memory: "Memory",
  model_call: "Model Call",
  tool_planning: "Tool Planning",
  tool_execution: "Tool Execution",
  mcp: "MCP",
  human_gate: "Human Gate",
  todo: "Todo",
  errors: "Errors",
  unscoped: "Unscoped",
};

export function buildTimelineExport(rows = [], options = {}) {
  const range = options.range || "last-1";
  const format = options.format || "markdown";
  const filter = options.filter || "all";

  const scoped = selectRowsForRange(rows, range === "raw" ? "full" : range);
  const events = scoped.filter((r) => r?.kind);
  const visible = events.filter((e) => shouldShowTimelineEvent(e, filter));

  if (format === "jsonl") return buildRawJsonl(visible);
  if (format === "csv") return renderTimelineCSV(visible, { ...options, range, filter });
  return renderTimelineMarkdown(visible, { ...options, range, filter });
}

export function timelineExportFileName(format, { traceId, range } = {}) {
  const id = (traceId || "trace").replace(/[^a-z0-9_-]/gi, "-");
  const r = (range || "last-1").replace(/[^a-z0-9_-]/gi, "-");
  const ext = format === "csv" ? "csv" : format === "jsonl" ? "jsonl" : "md";
  return `helixent-timeline-${id}-${r}.${ext}`;
}

function renderTimelineMarkdown(visible, options) {
  const graph = buildTimelineGraph(visible);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const lines = [];
  lines.push("# Helixent Timeline Export");
  lines.push(
    `- Range: ${RANGE_LABELS[options.range] || options.range} · Format: ${FORMAT_LABELS.markdown} · Filter: ${options.filter}`,
  );
  lines.push(`- Generated: ${generatedAt}`);
  if (options.session?.sessionId) lines.push(`- Session: ${options.session.sessionId}`);
  if (options.session?.model) lines.push(`- Model: ${options.session.model}`);
  if (options.traceId) lines.push(`- Trace: ${options.traceId}`);
  lines.push("");

  if (!graph.roots.length) {
    lines.push("_No timeline events in selected range._");
    return lines.join("\n");
  }

  for (const root of graph.roots) {
    renderNode(root, 2, lines);
  }
  return lines.join("\n");
}

function renderNode(node, level, lines) {
  if (node.type === "event") {
    renderEvent(node, level, lines);
    return;
  }
  const heading = "#".repeat(Math.min(level, 6));
  const indent = "  ".repeat(Math.max(level - 2, 0));
  const summary = nodeSummary(node);
  lines.push(`${indent}${heading} ${summary}`);
  for (const child of node.children || []) {
    renderNode(child, level + 1, lines);
  }
}

function renderEvent(node, level, lines) {
  const indent = "  ".repeat(Math.max(level - 2, 0));
  const time = node.at || node.event?.at || "";
  const subtitle = node.subtitle || node.event?.label || "";
  const subtitleSegment = subtitle ? ` — ${subtitle}` : "";
  const timeSegment = time ? ` @ ${time}` : "";
  const kindLabel = node.event?.kind || node.kind || "event";
  lines.push(`${indent}- ${kindLabel}${subtitleSegment}${timeSegment}`);
}

function nodeSummary(node) {
  const status = node.status ? ` · ${node.status}` : "";
  const duration = formatDuration(node.durationMs);
  if (node.type === "session") return `${node.title}${status}${duration}`;
  if (node.type === "run") return `${node.title}${node.requestId ? ` (${node.requestId})` : ""}${status}${duration}`;
  if (node.type === "agent_execution") return `${node.title}${status}${duration}`;
  if (node.type === "react_step") return `${node.title}${status}${duration}`;
  const phaseTitle = PHASE_TITLES[node.type] || node.title || node.type;
  return `[${node.type}] ${phaseTitle}${status}${duration}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : ` · ${ms}ms`;
}

function renderTimelineCSV(visible, options) {
  const header = ["at", "kind", "category", "agentId", "step", "phase", "label", "detail"];
  const lines = [header.join(",")];
  for (const event of visible) {
    const refs = event?.graph?.refs || {};
    const agentId = String(refs.agentId || event?.data?.agentId || "");
    const step = event?.graph?.step ?? event?.data?.step ?? "";
    const phase = phaseForEvent(event);
    const category = categoryForEvent(event);
    const label = event?.label || friendlyKind(event?.kind);
    const detail = detailForEvent(event);
    const row = [
      event?.at || "",
      event?.kind || "",
      category,
      agentId,
      step === undefined || step === null ? "" : String(step),
      phase,
      label,
      detail,
    ];
    lines.push(row.map(csvField).join(","));
  }
  // include header for context comments? leave plain CSV per plan.
  void options;
  return lines.join("\n");
}

function csvField(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…(truncated)` : raw;
  if (/[",\n\r]/.test(truncated)) {
    return `"${truncated.replaceAll('"', '""')}"`;
  }
  return truncated;
}

function categoryForEvent(event) {
  const kind = event?.kind || "";
  if (kind === "user_message") return "user";
  if (kind === "hook_triggered") return "hook";
  if (["input_context", "model_output_block", "token_usage", "agent_progress"].includes(kind)) return "model";
  if (["tool_call_detected", "tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(kind)) return "tool";
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(kind)) return "human";
  if (["skills_inventory", "skill_system_injected", "skill_loaded"].includes(kind)) return "skill";
  if (kind.startsWith?.("prompt_version_")) return "prompt";
  if (kind === "todo_update") return "todo";
  if (kind === "error") return "error";
  if (kind.startsWith?.("mcp_")) return "mcp";
  if (kind.startsWith?.("memory_")) return "memory";
  return "session";
}

function phaseForEvent(event) {
  const kind = event?.kind || "";
  if (kind === "user_message") return "user_input";
  if (kind === "error") return "errors";
  if (kind === "prompt_version_applied" || kind === "input_context") return "prompt_phase";
  if (["skills_inventory", "skill_system_injected", "skill_loaded"].includes(kind)) return "skills";
  if (kind.startsWith?.("memory_")) return "memory";
  if (kind.startsWith?.("mcp_")) return "mcp";
  if (kind === "hook_triggered") {
    const hook = event?.data?.hook;
    if (["beforeModel", "afterModel"].includes(hook)) return "model_call";
    if (["beforeToolUse", "afterToolUse"].includes(hook)) return "tool_execution";
    return "unscoped";
  }
  if (["model_output_block", "token_usage", "agent_progress"].includes(kind)) {
    return event?.data?.progress?.subtype === "tool" ? "tool_execution" : "model_call";
  }
  if (kind === "tool_call_detected") return "tool_planning";
  if (["tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(kind)) return "tool_execution";
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(kind)) return "human_gate";
  if (kind === "todo_update") return "todo";
  return "unscoped";
}

function detailForEvent(event) {
  const data = event?.data || {};
  if (event?.kind === "user_message") {
    const content = Array.isArray(data?.content) ? data.content : [];
    const parts = content
      .filter((b) => b?.type === "text" && typeof b?.text === "string")
      .map((b) => b.text);
    return parts.join(" ").trim();
  }
  if (event?.kind === "hook_triggered") return data.hook || "";
  if (event?.kind === "tool_call_detected") {
    const name = data?.toolUse?.name || "";
    const id = data?.toolUse?.id || data?.toolUseId || "";
    return [name, id].filter(Boolean).join(" · ");
  }
  if (event?.kind === "tool_execution_started" || event?.kind === "tool_execution_completed") {
    return data?.toolName || data?.name || "";
  }
  if (event?.kind === "token_usage") {
    const u = data?.usage || {};
    const parts = [];
    if (u.input_tokens != null) parts.push(`input=${u.input_tokens}`);
    if (u.output_tokens != null) parts.push(`output=${u.output_tokens}`);
    return parts.join(" ");
  }
  if (event?.kind === "model_output_block") return data?.block?.type || "";
  if (event?.kind === "agent_progress") return data?.progress?.subtype || data?.progress?.name || "";
  if (event?.kind === "todo_update") return `${data?.todos?.length || 0} todos`;
  if (event?.kind === "error") return data?.message || "";
  return "";
}

function friendlyKind(kind = "") {
  return String(kind).replaceAll("_", " ");
}
