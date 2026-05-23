// @ts-nocheck

const DEFAULT_RANGE = "last-1";

export function buildTraceExport(rows = [], options = {}) {
  const range = options.range || DEFAULT_RANGE;
  const selectedRows = selectRowsForRange(rows, range === "raw" ? "full" : range);
  if (range === "raw") return buildRawJsonl(selectedRows);
  return buildTraceMarkdown(selectedRows, options);
}

export function selectRowsForRange(rows = [], range = DEFAULT_RANGE) {
  if (range === "full" || range === "raw") return [...rows];
  const count = Number(String(range).replace("last-", ""));
  if (!Number.isFinite(count) || count <= 0) return [...rows];

  const starts = [];
  rows.forEach((row, index) => {
    if (isUserRunMessage(row)) starts.push(index);
  });
  if (!starts.length) return [...rows];
  if (starts.length <= count) return rows.slice(starts[0]);
  return rows.slice(starts[starts.length - count]);
}

export function buildTraceMarkdown(rows = [], options = {}) {
  const events = rows.filter((row) => row?.kind);
  const messages = rows.filter((row) => row?.type === "message" && row.message).map((row) => row.message);
  const latestContext = latestEvent(events, "input_context");
  const outputRows = rows.filter((row) => isOutputRow(row));
  const timelineRows = rows.filter((row) => row?.kind && shouldExportTimeline(row));
  const userQueries = rows.filter((row) => isUserRunMessage(row)).map((row) => messageText(row.message));
  const session = options.session || {};
  const traceId = options.traceId || session.traceId || session.sessionId || "current";
  const generatedAt = options.generatedAt || new Date().toISOString();
  const lines = [];

  lines.push(`# Helixent Trace Export`);
  lines.push("");
  lines.push(`## Metadata`);
  lines.push(`- Trace: ${safeInline(traceId)}`);
  lines.push(`- Range: ${safeInline(formatRange(options.range || DEFAULT_RANGE))}`);
  lines.push(`- Generated: ${safeInline(generatedAt)}`);
  if (session.cwd) lines.push(`- CWD: ${safeInline(session.cwd)}`);
  if (session.model) lines.push(`- Model: ${safeInline(session.model)}`);
  lines.push(`- Rows: ${rows.length}`);
  lines.push("");

  lines.push(`## User Query`);
  if (userQueries.length) {
    userQueries.forEach((query, index) => {
      lines.push(`### Query ${index + 1}`);
      lines.push(query.trim() || "_Empty user query._");
      lines.push("");
    });
  } else {
    lines.push("_No user query captured in the selected range._");
    lines.push("");
  }

  lines.push(`## Prompt Playground Snapshot`);
  lines.push(...renderPromptPlaygroundSnapshot(latestContext, messages));
  lines.push("");

  lines.push(`## Model Output`);
  if (outputRows.length) {
    outputRows.forEach((row, index) => {
      lines.push(...renderOutputRow(row, index + 1));
      lines.push("");
    });
  } else {
    lines.push("_No model output rows captured._");
    lines.push("");
  }

  lines.push(`## Hook & Tool Timeline`);
  if (timelineRows.length) {
    timelineRows.forEach((row, index) => lines.push(renderTimelineRow(row, index + 1)));
  } else {
    lines.push("_No hook or tool timeline rows captured._");
  }
  lines.push("");

  if (options.range === "full") {
    lines.push(`## Raw Appendix`);
    lines.push("```jsonl");
    lines.push(buildRawJsonl(rows));
    lines.push("```");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function buildRawJsonl(rows = []) {
  return rows.map((row) => JSON.stringify(stripClientFields(row))).join("\n") + (rows.length ? "\n" : "");
}

function renderPromptPlaygroundSnapshot(context, messages = []) {
  if (!context) {
    return [
      "_No `input_context` event captured in the selected range._",
      `- Session messages in range: ${messages.length}`,
    ];
  }
  const prompt = context.data?.prompt || "";
  const modelMessages = context.data?.messages || [];
  const tools = context.data?.tools || [];
  const skills = extractSkillsFromPrompt(prompt);
  const summary = summarizePrompt(prompt);
  const requestedSkillName = context.data?.requestedSkillName || "";
  const lines = [
    `- Model request: ${safeInline(context.label || "input_context")}`,
    `- Source: ${safeInline(context.data?.source || "runtime")}${context.data?.versionName ? ` · ${safeInline(context.data.versionName)}` : ""}`,
    `- System prompt: ${lineCount(prompt)} lines`,
    `- Messages sent to model: ${modelMessages.length}`,
    `- Visible tools: ${tools.length}${tools.length ? ` (${tools.slice(0, 12).map((tool) => safeInline(tool.name || "tool")).join(", ")}${tools.length > 12 ? ", ..." : ""})` : ""}`,
    `- Forced skill: ${requestedSkillName ? `/${safeInline(requestedSkillName)}` : "(none)"}`,
    `- Prompt version id: ${context.data?.versionId ? safeInline(context.data.versionId) : "(none)"}`,
    `- Skills in prompt: ${skills.length}${skills.length ? ` (${skills.slice(0, 8).map((skill) => safeInline(skill)).join(", ")}${skills.length > 8 ? ", ..." : ""})` : ""}`,
  ];
  if (summary.length) {
    lines.push("");
    lines.push("### System Prompt Preview");
    summary.forEach((line) => lines.push(`- ${line}`));
  }
  return lines;
}

function renderOutputRow(row, index) {
  if (row.kind === "model_output_block") {
    const block = row.data?.block || {};
    if (block.type === "thinking") {
      return [`### ${index}. Thinking`, eventRefLine(row), "", block.thinking || ""].filter(Boolean);
    }
    if (block.type === "text") {
      return [`### ${index}. Response`, eventRefLine(row), "", block.text || ""].filter(Boolean);
    }
    if (block.type === "tool_use") {
      return [
        `### ${index}. Model Requested Tool: ${safeInline(block.name || "tool")}`,
        eventRefLine(row),
        "",
        "```json",
        JSON.stringify(block.input || {}, null, 2),
        "```",
      ].filter(Boolean);
    }
    return [`### ${index}. Model Output Block: ${safeInline(block.type || "unknown")}`, eventRefLine(row), "", fencedJson(block)].filter(Boolean);
  }

  if (row.kind === "tool_call_detected") {
    return [`### ${index}. Harness Detected Tool Call`, eventRefLine(row), "", fencedJson(row.data?.toolUse || row.data || {})].filter(Boolean);
  }

  if (row.kind === "error") {
    return [`### ${index}. Runtime Error`, eventRefLine(row), "", row.label || row.data?.message || "Unknown error"].filter(Boolean);
  }

  if (row.type === "message" && row.message?.role === "tool") {
    return [`### ${index}. Tool Result`, "", fencedJson(row.message.content || [])].filter(Boolean);
  }

  return [`### ${index}. Output Row`, "", fencedJson(row)].filter(Boolean);
}

function renderTimelineRow(row, index = 1) {
  const label = row.label || row.kind;
  const detail = timelineDetail(row);
  const parts = [`step=${index}`, `kind=${safeInline(row.kind)}`, `label=${safeInline(label)}`];
  if (detail) parts.push(`detail=${detail}`);
  return `- ${parts.join(" | ")}`;
}

function timelineDetail(row) {
  if (row.kind === "hook_triggered") return safeInline(row.data?.hook || "");
  if (row.kind === "prompt_version_applied") return safeInline(row.data?.versionName || row.data?.versionId || "");
  if (row.kind === "prompt_version_saved") return safeInline(row.data?.version?.name || row.data?.versionId || "");
  if (row.kind === "prompt_version_activated") return safeInline(row.data?.version?.name || row.data?.versionId || row.data?.activeVersionId || "");
  if (row.kind === "prompt_version_deleted") return safeInline(row.data?.versionId || "");
  if (row.kind === "tool_call_detected") return safeInline(row.data?.toolUse?.name || row.data?.toolUse?.id || "");
  if (row.kind === "tool_execution_started" || row.kind === "tool_execution_completed") return safeInline(row.data?.toolUse?.name || row.data?.resultSummary || "");
  if (row.kind === "skill_loaded") return safeInline(row.data?.skill?.name || row.data?.path || "");
  if (row.kind === "token_usage") return safeInline(formatUsage(row.data?.usage || {}));
  if (row.kind === "todo_update") return safeInline(row.data?.summary || `${row.data?.todos?.length || 0} todos`);
  if (row.kind === "error") return safeInline(row.data?.message || row.label || "");
  return "";
}

function isOutputRow(row) {
  if (row?.kind === "model_output_block") return true;
  if (row?.kind === "tool_call_detected") return true;
  if (row?.kind === "error" && row.data?.showInOutput !== false) return true;
  return row?.type === "message" && row.message?.role === "tool";
}

function shouldExportTimeline(row) {
  return [
    "hook_triggered",
    "prompt_version_applied",
    "prompt_version_saved",
    "prompt_version_activated",
    "prompt_version_deleted",
    "tool_execution_started",
    "tool_execution_completed",
    "tool_disabled",
    "skill_loaded",
    "approval_requested",
    "approval_resolved",
    "question_requested",
    "question_resolved",
    "token_usage",
    "todo_update",
    "error",
  ].includes(row.kind);
}

function isUserRunMessage(row) {
  if (row?.type !== "message" || row.message?.role !== "user") return false;
  const text = messageText(row.message);
  return !text.includes("The `AGENTS.md` file has been automatically loaded");
}

function messageText(message) {
  return (message.content || [])
    .map((content) => {
      if (content.type === "text") return content.text || "";
      if (content.type === "tool_result") return content.content || "";
      if (content.type === "tool_use") return JSON.stringify(content.input || {});
      return JSON.stringify(content);
    })
    .join("\n");
}

function latestEvent(events = [], kind) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].kind === kind) return events[index];
  }
  return null;
}

function summarizePrompt(prompt = "") {
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("<") && !line.startsWith("</"))
    .slice(0, 8);
}

function lineCount(value = "") {
  if (!value) return 0;
  return value.split("\n").length;
}

function extractSkillsFromPrompt(prompt = "") {
  return [...prompt.matchAll(/<skill\s+name="([^"]+)"/g)].map((match) => match[1]);
}

function formatUsage(usage) {
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens;
  const total = usage.total_tokens ?? usage.totalTokens ?? (typeof input === "number" && typeof output === "number" ? input + output : undefined);
  return [`input=${input ?? "-"}`, `output=${output ?? "-"}`, `total=${total ?? "-"}`].join(" ");
}

function formatRange(range) {
  if (range === "full") return "Full Trace";
  if (range === "raw") return "Raw JSONL";
  const count = String(range || DEFAULT_RANGE).replace("last-", "");
  return `Last ${count} run${count === "1" ? "" : "s"}`;
}

function fencedJson(value) {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function eventRefLine(row) {
  const refs = [];
  if (row.requestId) refs.push(`request=${row.requestId}`);
  if (row.kind) refs.push(`kind=${row.kind}`);
  if (row.data?.blockIndex !== undefined) refs.push(`block=${row.data.blockIndex}`);
  return refs.length ? `_trace_ref: ${refs.join(" | ")}_` : "";
}

function safeInline(value) {
  return String(value ?? "").replaceAll("\n", " ").trim();
}

function stripClientFields(row) {
  if (!row || typeof row !== "object") return row;
  const rest = { ...row };
  delete rest.__clientReceivedAt;
  return rest;
}
