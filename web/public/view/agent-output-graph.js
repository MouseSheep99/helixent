import { extractImagesFromMessage, renderThumbnailStrip, sanitizeImagesForDebugDump, summarizeMessageWithImages } from "./images.js";
import { summarizeMessageText } from "./messages.js";
import { renderSentPromptIcon } from "./sent-prompt.js";
import { contentToText, escapeAttr, escapeHtml } from "./utils.js";

export function isAgentOutputRow(row) {
  if (row?.type === "message" && row.message) return true;
  if (row?.kind === "input_context") return true;
  if (row?.kind === "model_output_block") return true;
  if (row?.kind === "tool_call_detected") return true;
  if (row?.kind === "error") return row.data?.showInOutput !== false;
  return false;
}

export function buildAgentOutputGraph(rows = [], _options = {}) {
  const graph = { runs: [], nodeById: {}, systemErrors: [] };
  const toolByUseId = new Map();
  const stepByToolUseId = new Map();
  let currentRun = null;
  let currentStep = null;
  let pendingSentPromptRowIndex = -1;
  let messageIndex = -1;

  const register = (node) => {
    graph.nodeById[node.id] = node;
    return node;
  };

  const ensureRun = (rowIndex = -1) => {
    if (currentRun) return currentRun;
    currentRun = register({
      id: `run:${graph.runs.length + 1}`,
      type: "run",
      index: graph.runs.length + 1,
      title: "Legacy Run",
      sentPromptRowIndex: pendingSentPromptRowIndex,
      status: "success",
      steps: [],
      errors: [],
      rowIndex,
    });
    graph.runs.push(currentRun);
    return currentRun;
  };

  const createStep = (run, rowIndex = -1) => {
    const step = register({
      id: `step:${run.index}:${run.steps.length + 1}`,
      type: "react_step",
      runIndex: run.index,
      stepIndex: run.steps.length + 1,
      step: run.steps.length + 1,
      title: `ReAct ${run.steps.length + 1}`,
      status: "success",
      thinking: [],
      tools: [],
      response: [],
      errors: [],
      rowIndex,
    });
    run.steps.push(step);
    currentStep = step;
    return step;
  };

  const ensureStep = (rowIndex = -1) => createStep(ensureRun(rowIndex), rowIndex);

  const addItem = (item) => register(item);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!isAgentOutputRow(row)) continue;

    if (row.kind === "input_context") {
      pendingSentPromptRowIndex = rowIndex;
      if (currentRun) currentRun.sentPromptRowIndex = rowIndex;
      continue;
    }

    if (row.type === "message" && row.message) {
      messageIndex += 1;
      const message = row.message;
      if (message.role === "user") {
        const text = messageText(message);
        const isProjectContext = isProjectContextMessage(message);
        const images = extractImagesFromMessage(message);
        const summary = summarizeMessageWithImages(message);
        const titleText = isProjectContext
          ? "Project context"
          : summary.text
            ? summarizeMessageText(summary.text)
            : summary.imageCount > 0
              ? `${summary.imageCount} image${summary.imageCount === 1 ? "" : "s"}`
              : summarizeMessageText(text);
        currentRun = register({
          id: `run:${graph.runs.length + 1}`,
          type: "run",
          index: graph.runs.length + 1,
          title: titleText,
          requestId: row.requestId || message.requestId || undefined,
          imageCount: images.length,
          images,
          user: addItem({
            id: `item:${rowIndex}:user`,
            type: "user",
            rowIndex,
            messageIndex,
            content: message,
            text,
            images,
            isProjectContext,
          }),
          sentPromptRowIndex: pendingSentPromptRowIndex,
          status: "success",
          steps: [],
          errors: [],
          rowIndex,
        });
        graph.runs.push(currentRun);
        currentStep = null;
        continue;
      }

      if (message.role === "tool") {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const [blockIndex, block] of blocks.entries()) {
          if (block?.type !== "tool_result") continue;
          const toolUseId = block.tool_use_id;
          let tool = toolUseId ? toolByUseId.get(toolUseId) : findLatestPendingTool(currentRun);
          let targetStep = toolUseId ? stepByToolUseId.get(toolUseId) : null;
          if (!tool) {
            targetStep = targetStep || ensureStep(rowIndex);
            tool = createToolNode({
              run: ensureRun(rowIndex),
              step: targetStep,
              rowIndex,
              blockIndex,
              toolUse: { id: toolUseId, name: "unknown_tool", input: {} },
              register,
            });
            if (toolUseId) {
              toolByUseId.set(toolUseId, tool);
              stepByToolUseId.set(toolUseId, targetStep);
            }
          }
          tool.result = addItem({
            id: `item:${rowIndex}:tool_result:${blockIndex}`,
            type: "tool_result",
            rowIndex,
            blockIndex,
            messageIndex,
            content: block,
          });
        }
        currentStep = null;
        continue;
      }

      if (message.role === "assistant" && !message.__skipModelOutput) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const [blockIndex, block] of blocks.entries()) {
          ingestModelOutputBlock({ block, rowIndex, blockIndex, messageIndex });
        }
      }
      continue;
    }

    if (row.kind === "model_output_block") {
      const block = row.data?.block;
      if (!block) continue;
      ingestModelOutputBlock({ block, rowIndex, blockIndex: row.data?.blockIndex });
      continue;
    }

    if (row.kind === "tool_call_detected") {
      const toolUse = row.data?.toolUse || {};
      const toolUseId = toolUse.id;
      const tool = toolUseId ? toolByUseId.get(toolUseId) : null;
      if (tool) {
        tool.detected = addItem({
          id: `item:${rowIndex}:tool_detected`,
          type: "tool_detected",
          rowIndex,
          blockIndex: row.data?.blockIndex,
          content: toolUse,
        });
      }
      continue;
    }

    if (row.kind === "error" && row.data?.showInOutput !== false) {
      const item = addItem({
        id: `item:${rowIndex}:error`,
        type: "error",
        rowIndex,
        content: row,
        text: row.label || row.data?.message || "Unknown error",
      });
      const isClientError = row.data?.source === "client" || row.data?.scope === "ui";
      if (isClientError || !currentRun) {
        graph.systemErrors.push(item);
      } else if (currentStep) {
        currentStep.errors.push(item);
      } else {
        currentRun.errors.push(item);
      }
    }
  }

  for (const run of graph.runs) {
    updateRunStatus(run);
    markFinalResponse(run);
  }
  assignAgentOutputNodeIds(graph);
  return graph;

  function ingestModelOutputBlock({ block, rowIndex, blockIndex, messageIndex: sourceMessageIndex = undefined }) {
    if (!block || typeof block !== "object") return;
    if ((block.type === "thinking" || block.type === "tool_use") && currentStep?.response.length && currentStep.rowIndex !== rowIndex) {
      currentStep = null;
    }
    const step = currentStep || ensureStep(rowIndex);

    if (block.type === "thinking") {
      if (!String(block.thinking || "").trim()) return;
      step.thinking.push(addItem({
        id: `item:${rowIndex}:thinking:${blockIndex ?? step.thinking.length}`,
        type: "thinking",
        rowIndex,
        blockIndex,
        messageIndex: sourceMessageIndex,
        content: block,
        text: block.thinking || "",
      }));
      return;
    }

    if (block.type === "text") {
      if (!String(block.text || "").trim()) return;
      step.response.push(addItem({
        id: `item:${rowIndex}:response:${blockIndex ?? step.response.length}`,
        type: "response",
        rowIndex,
        blockIndex,
        messageIndex: sourceMessageIndex,
        content: block,
        text: block.text || "",
      }));
      return;
    }

    if (block.type === "tool_use") {
      const tool = createToolNode({
        run: ensureRun(rowIndex),
        step,
        rowIndex,
        blockIndex,
        toolUse: block,
        messageIndex: sourceMessageIndex,
        register,
      });
      if (tool.toolUseId) {
        toolByUseId.set(tool.toolUseId, tool);
        stepByToolUseId.set(tool.toolUseId, step);
      }
      return;
    }

    step.response.push(addItem({
      id: `item:${rowIndex}:response:${blockIndex ?? step.response.length}`,
      type: "response",
      rowIndex,
      blockIndex,
      messageIndex: sourceMessageIndex,
      content: block,
      text: JSON.stringify(block),
    }));
  }
}

function findLatestPendingTool(run) {
  if (!run) return null;
  for (let stepIndex = run.steps.length - 1; stepIndex >= 0; stepIndex--) {
    const step = run.steps[stepIndex];
    for (let toolIndex = step.tools.length - 1; toolIndex >= 0; toolIndex--) {
      const tool = step.tools[toolIndex];
      if (!tool.result) return tool;
    }
  }
  return null;
}

function createToolNode({ run, step, rowIndex, blockIndex, toolUse = {}, messageIndex, register }) {
  const toolUseId = toolUse.id || undefined;
  const tool = register({
    id: toolUseId ? `tool:${toolUseId}` : `tool:${run.index}:${step.stepIndex}:${step.tools.length + 1}`,
    type: "tool",
    toolUseId,
    name: toolUse.name || "unknown_tool",
    input: toolUse.input || {},
    request: toolUse.name
      ? register({
        id: `item:${rowIndex}:tool_use:${blockIndex ?? step.tools.length}`,
        type: "tool_use",
        rowIndex,
        blockIndex,
        messageIndex,
        content: toolUse,
      })
      : undefined,
    detected: undefined,
    result: undefined,
    status: "pending",
  });
  step.tools.push(tool);
  return tool;
}

function updateRunStatus(run) {
  for (const step of run.steps) {
    for (const tool of step.tools) {
      tool.status = toolStatus(tool);
    }
    step.status = step.errors.length || step.tools.some((tool) => tool.status === "error")
      ? "error"
      : step.tools.some((tool) => tool.status === "pending")
        ? "pending"
        : "success";
  }
  run.status = run.errors.length || run.steps.some((step) => step.status === "error")
    ? "error"
    : run.steps.some((step) => step.status === "pending")
      ? "running"
      : "success";
}

// UI-2: 标记最后一个 step 的最后一个 response 为 final answer。
function markFinalResponse(run) {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (step.response.length) {
      step.response[step.response.length - 1].isFinal = true;
      return;
    }
  }
}

// Stamp canonical nodeId / scopeId onto every output-view node so the renderer
// can emit `data-node-id` / `data-node-scope` without re-deriving anything.
// Naming follows web/public/view/canonical-graph.js.
function assignAgentOutputNodeIds(graph) {
  for (const run of graph.runs) {
    const reqKey = run.requestId || `synthetic-${run.index}`;
    run.nodeId = `run:${reqKey}`;
    const agentNodeId = `agent:${reqKey}:lead`;
    run.agentNodeId = agentNodeId;
    if (run.user) {
      const seq = run.user.messageIndex !== undefined ? run.user.messageIndex : 0;
      run.user.nodeId = `message:${reqKey}:user:${seq}`;
      run.user.scopeId = run.nodeId;
    }
    for (let s = 0; s < run.steps.length; s++) {
      const step = run.steps[s];
      const stepNodeId = `step:${reqKey}:lead:${step.stepIndex}`;
      step.nodeId = stepNodeId;
      step.scopeId = run.nodeId;
      for (let k = 0; k < step.thinking.length; k++) {
        step.thinking[k].nodeId = `thinking:${run.index}:${step.stepIndex}:${k}`;
        step.thinking[k].scopeId = stepNodeId;
      }
      for (let k = 0; k < step.tools.length; k++) {
        const tool = step.tools[k];
        tool.nodeId = tool.toolUseId
          ? `tool:${tool.toolUseId}`
          : `tool:${reqKey}:lead:${step.stepIndex}:${k}`;
        tool.scopeId = stepNodeId;
      }
      for (let k = 0; k < step.response.length; k++) {
        step.response[k].nodeId = `response:${run.index}:${step.stepIndex}:${k}`;
        step.response[k].scopeId = stepNodeId;
      }
      for (let k = 0; k < step.errors.length; k++) {
        const err = step.errors[k];
        err.nodeId = `error:${err.rowIndex ?? `${run.index}:${step.stepIndex}:${k}`}`;
        err.scopeId = stepNodeId;
      }
    }
    for (let k = 0; k < run.errors.length; k++) {
      const err = run.errors[k];
      err.nodeId = `error:${err.rowIndex ?? `${run.index}:run:${k}`}`;
      err.scopeId = run.nodeId;
    }
  }
  for (let k = 0; k < (graph.systemErrors || []).length; k++) {
    const err = graph.systemErrors[k];
    err.nodeId = `error:${err.rowIndex ?? `system:${k}`}`;
  }
}

function toolStatus(tool) {
  if (!tool.result) return "pending";
  return isToolResultError(tool.result.content) ? "error" : "success";
}

function isToolResultError(content) {
  const text = typeof content?.content === "string" ? content.content : JSON.stringify(content || "");
  return text.trim().startsWith("Error:");
}

function messageText(message) {
  return (message.content || []).map(contentToText).join("\n\n");
}

function isProjectContextMessage(message) {
  return message.role === "user" && messageText(message).includes("The `AGENTS.md` file has been automatically loaded");
}

const AGENT_STATUS_CHIP_TONES = {
  success: { label: "ok", tone: "model" },
  running: { label: "running", tone: "step" },
  pending: { label: "pending", tone: "tool" },
  error: { label: "error", tone: "error" },
};

export function renderAgentOutputGraph(graph, options = {}) {
  const runCount = graph.runs.length;
  const systemErrors = graph.systemErrors || [];
  return `
    <div class="agent-output-graph" data-run-count="${runCount}">
      ${renderSystemErrorsSection(systemErrors)}
      ${renderChatThread(graph, options)}
    </div>`;
}

function renderSystemErrorsSection(items) {
  if (!items || !items.length) return "";
  const body = items
    .map((item) => `
      <div class="agent-output-system-error" data-tone="error">
        <span class="agent-chip" data-tone="error">ERR</span>
        <span class="agent-output-system-error-text">${escapeHtml(item.text || "Unknown error")}</span>
      </div>`)
    .join("");
  return `
    <details class="agent-output-system-errors" open>
      <summary>
        <span class="agent-chip" data-tone="error">SYS</span>
        <span class="agent-row-copy">
          <span class="agent-row-title">System notices</span>
          <span class="agent-row-subtitle">${items.length} item${items.length === 1 ? "" : "s"} not tied to any run</span>
        </span>
      </summary>
      <div class="agent-output-system-errors-body">${body}</div>
    </details>`;
}

// UI-1: 扁平 chat-thread 渲染（弱化 Run 概念，对齐业界 thread 范式）。
export function renderChatThread(graph, options = {}) {
  const turns = graph.runs.map((run) => `${renderUserTurn(run)}${renderAgentTurn(run, options)}`);
  return `<div class="chat-thread">${turns.join("")}</div>`;
}

function renderUserTurn(run) {
  if (!run.user) return "";
  const userNodeAttr = run.user.nodeId ? ` data-node-id="${escapeAttr(run.user.nodeId)}"` : "";
  const scopeAttr = run.nodeId ? ` data-node-scope="${escapeAttr(run.nodeId)}"` : "";
  const idxAttr = run.user.messageIndex !== undefined ? ` data-message-index="${run.user.messageIndex}"` : "";
  if (run.user.isProjectContext) {
    return `
      <div class="chat-context-pill"${userNodeAttr}${scopeAttr}${idxAttr}>
        <span class="agent-chip" data-tone="default">CTX</span>
        <span class="chat-context-label">Project context</span>
        <span class="chat-context-text">${escapeHtml(summarizeMessageText(run.user.text || ""))}</span>
      </div>`;
  }
  const text = run.user.text || "";
  const images = Array.isArray(run.user.images) ? run.user.images : [];
  if (!text && !images.length) return "";
  const stripHtml = images.length
    ? `<div class="user-bubble-images">${renderThumbnailStrip(images, { size: 80, group: `user-${run.index}` })}</div>`
    : "";
  const textHtml = text ? `<div class="user-bubble-text">${escapeHtml(text)}</div>` : "";
  return `
    <div class="user-bubble" role="button" tabindex="0"${idxAttr}${userNodeAttr}${scopeAttr}>
      ${stripHtml}
      ${textHtml}
    </div>`;
}

function renderAgentTurn(run, options) {
  const trail = renderReasoningTrail(run, options);
  const finalHtml = renderFinalAnswer(run);
  const agentAttr = run.agentNodeId ? ` data-node-id="${escapeAttr(run.agentNodeId)}"` : "";
  const scopeAttr = run.nodeId ? ` data-node-scope="${escapeAttr(run.nodeId)}"` : "";
  const sentPromptIcon = renderSentPromptIcon(run.sentPromptRowIndex);
  const meta = sentPromptIcon ? `<div class="agent-turn-meta">${sentPromptIcon}</div>` : "";
  if (!trail && !finalHtml) {
    return `<div class="agent-turn empty" data-status="${escapeAttr(run.status)}"${agentAttr}${scopeAttr}>${meta}<div class="agent-detail-empty">No model output in this run yet.</div></div>`;
  }
  return `
    <div class="agent-turn" data-status="${escapeAttr(run.status)}"${agentAttr}${scopeAttr}>
      ${meta}
      ${trail}
      ${finalHtml}
    </div>`;
}

function renderReasoningTrail(run, options = {}) {
  // 收集 turn 级 inline 项：每个 step 的 thinking + tools，以及非 final 的 response。
  const items = [];
  for (const step of run.steps) {
    for (const t of step.thinking) items.push({ kind: "thinking", item: t, step });
    for (const t of step.tools) items.push({ kind: "tool", item: t, step });
    for (const r of step.response) {
      if (!r.isFinal) items.push({ kind: "response_inline", item: r, step });
    }
    for (const e of step.errors) items.push({ kind: "error", item: e, step });
  }
  for (const e of run.errors) items.push({ kind: "error", item: e, step: null });

  if (!items.length) return "";

  const stepCount = run.steps.length;
  const toolCount = items.filter((x) => x.kind === "tool").length;
  const toolNames = [...new Set(items.filter((x) => x.kind === "tool").map((x) => x.item.name))].slice(0, 5);
  const summary = [
    `Thought for ${stepCount} step${stepCount === 1 ? "" : "s"}`,
    toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "",
    toolNames.length ? toolNames.join(" · ") : "",
  ].filter(Boolean).join(" · ");
  const isOpen = run.status === "error" || options.forceOpenReasoning;
  const inspectButton = run.user?.messageIndex !== undefined
    ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${run.user.messageIndex}">Inspect</button>`
    : "";
  const scopeAttr = run.nodeId ? ` data-node-scope="${escapeAttr(run.nodeId)}"` : "";
  const body = items.map((x) => renderTrailItem(x, run)).join("");
  return `
    <details class="reasoning-trail" data-status="${escapeAttr(run.status)}" ${isOpen ? "open" : ""}${scopeAttr}>
      <summary class="reasoning-trail-summary">
        <span class="reasoning-trail-icon" aria-hidden="true"></span>
        <span class="reasoning-trail-text">${escapeHtml(summary)}</span>
        <span class="reasoning-trail-meta">
          ${renderAgentStatusChip(run.status)}
          ${inspectButton}
        </span>
      </summary>
      <div class="reasoning-trail-body">${body}</div>
    </details>`;
}

function renderTrailItem({ kind, item, step }, _run) {
  const nodeAttr = item.nodeId ? ` data-node-id="${escapeAttr(item.nodeId)}"` : "";
  const scopeAttr = item.scopeId ? ` data-node-scope="${escapeAttr(item.scopeId)}"` : (step?.nodeId ? ` data-node-scope="${escapeAttr(step.nodeId)}"` : "");
  if (kind === "thinking") {
    const text = item.text || item.content?.thinking || "";
    return `
      <div class="trail-item trail-thinking"${nodeAttr}${scopeAttr}>
        <span class="trail-thinking-quote" aria-hidden="true">❝</span>
        <div class="trail-thinking-text">${escapeHtml(text)}</div>
      </div>`;
  }
  if (kind === "tool") {
    const subtitle = summarizeToolInput(item.input);
    const inspectButton = item.result?.messageIndex !== undefined
      ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${item.result.messageIndex}">Inspect</button>`
      : "";
    const detail = `
      ${item.request ? renderToolSection("Input", item.input || item.request.content?.input || {}) : ""}
      ${item.detected ? renderToolSection("Detected", item.detected.content || {}) : ""}
      ${item.result ? renderToolSection("Result", item.result.content || {}) : `<div class="agent-detail-empty">Tool result pending.</div>`}
    `;
    return `
      <details class="trail-item trail-tool tool-call" data-status="${escapeAttr(item.status)}"${nodeAttr}${scopeAttr}>
        <summary class="trail-tool-summary">
          <span class="trail-tool-icon" aria-hidden="true">⚙</span>
          <span class="trail-tool-name">${escapeHtml(item.name)}</span>
          <span class="trail-tool-subtitle">${escapeHtml(subtitle)}</span>
          <span class="trail-tool-meta">
            ${renderAgentStatusChip(item.status)}
            ${inspectButton}
          </span>
        </summary>
        <div class="trail-tool-detail">${detail}</div>
      </details>`;
  }
  if (kind === "response_inline") {
    const text = item.text || formatOutputValue(item.content);
    return `
      <div class="trail-item trail-response-inline"${nodeAttr}${scopeAttr}>
        <div class="trail-response-text">${escapeHtml(text)}</div>
      </div>`;
  }
  if (kind === "error") {
    const text = item.text || item.content?.label || item.content?.data?.message || "Unknown error";
    return `
      <div class="trail-item trail-error"${nodeAttr}${scopeAttr}>
        <span class="trail-error-icon" aria-hidden="true">✕</span>
        <span class="trail-error-text">Runtime error — ${escapeHtml(text)}</span>
      </div>`;
  }
  return "";
}

function renderFinalAnswer(run) {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    const finalItem = step.response.find((r) => r.isFinal);
    if (!finalItem) continue;
    const text = finalItem.text || finalItem.content?.text || "";
    if (!String(text).trim()) return "";
    const nodeAttr = finalItem.nodeId ? ` data-node-id="${escapeAttr(finalItem.nodeId)}"` : "";
    const scopeAttr = step.nodeId ? ` data-node-scope="${escapeAttr(step.nodeId)}"` : "";
    return `
      <div class="final-answer"${nodeAttr}${scopeAttr}>
        <div class="final-answer-text">${escapeHtml(text)}</div>
      </div>`;
  }
  return "";
}

function renderToolSection(label, value) {
  const safeValue = sanitizeImagesForDebugDump(value);
  return `
    <section class="agent-detail-section">
      <div class="agent-detail-section-title">${escapeHtml(label)}</div>
      <pre class="agent-detail-pre">${escapeHtml(formatOutputValue(safeValue))}</pre>
    </section>`;
}

function renderAgentStatusChip(status = "success") {
  const entry = AGENT_STATUS_CHIP_TONES[status] || AGENT_STATUS_CHIP_TONES.success;
  return `<span class="agent-status-chip" data-tone="${escapeAttr(entry.tone)}" data-status="${escapeAttr(status)}">${escapeHtml(entry.label)}</span>`;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const priorityKeys = ["description", "command", "path", "file_path", "pattern", "url", "query"];
  for (const key of priorityKeys) {
    if (typeof input[key] === "string" && input[key]) return `${key}: ${input[key]}`;
  }
  const entries = Object.entries(input);
  if (!entries.length) return "";
  const [k, v] = entries[0];
  return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
}

function formatOutputValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {}, null, 2);
}
