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
  const graph = { runs: [], nodeById: {} };
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
      const run = ensureRun(rowIndex);
      const item = addItem({
        id: `item:${rowIndex}:error`,
        type: "error",
        rowIndex,
        content: row,
        text: row.label || row.data?.message || "Unknown error",
      });
      if (currentStep) currentStep.errors.push(item);
      else run.errors.push(item);
    }
  }

  for (const run of graph.runs) {
    updateRunStatus(run);
  }
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

// Type → chip label / tone dictionary. Adding a new node type means adding a key
// here (and a matching tone CSS rule); render functions stay untouched. See §7.8.
const AGENT_OUTPUT_CHIP_TONES = {
  run: { label: "RUN", tone: "run" },
  react_step: { label: "STEP", tone: "step" },
  thinking: { label: "THINK", tone: "prompt" },
  response: { label: "RESP", tone: "model" },
  tool: { label: "TOOL", tone: "tool" },
  error: { label: "ERR", tone: "error" },
};

const AGENT_STATUS_CHIP_TONES = {
  success: { label: "ok", tone: "model" },
  running: { label: "running", tone: "step" },
  pending: { label: "pending", tone: "tool" },
  error: { label: "error", tone: "error" },
};

export function renderAgentOutputGraph(graph, options = {}) {
  const runCount = graph.runs.length;
  return `
    <div class="agent-output-graph" data-run-count="${runCount}">
      ${graph.runs.map((run, index) => renderAgentRunNode(run, { ...options, isLatestRun: index === runCount - 1, runCount })).join("")}
    </div>`;
}

function renderAgentRunNode(run, options = {}) {
  const isOpen = options.isLatestRun || options.runCount === 1;
  const toolNames = run.steps.flatMap((step) => step.tools.map((tool) => tool.name));
  const uniqueToolNames = [...new Set(toolNames)].slice(0, 4);
  const subtitle = [
    run.user?.isProjectContext ? "Project context" : "",
    run.user?.text ? summarizeMessageText(run.user.text) : "",
    `${run.steps.length} ReAct step${run.steps.length === 1 ? "" : "s"}`,
    `${toolNames.length} tool${toolNames.length === 1 ? "" : "s"}`,
    uniqueToolNames.length ? uniqueToolNames.join(", ") : "",
  ].filter(Boolean).join(" · ");
  const inspectButton = run.user?.messageIndex !== undefined
    ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${run.user.messageIndex}">Inspect</button>`
    : "";
  const imageChip = run.imageCount
    ? `<span class="agent-chip" data-tone="prompt">📎 ${run.imageCount}</span>`
    : "";
  const userImagesStrip = run.user && Array.isArray(run.user.images) && run.user.images.length
    ? `<div class="agent-run-user-images">${renderThumbnailStrip(run.user.images, { size: 80, group: `run-${run.index}-user` })}</div>`
    : "";
  return `
    <details class="agent-run" data-status="${escapeAttr(run.status)}" ${isOpen ? "open" : ""}>
      <summary class="agent-run-summary">
        ${renderAgentAnchor({ withHook: false })}
        ${renderAgentChip("run", run.status)}
        <span class="agent-row-copy">
          <span class="agent-row-title">${escapeHtml(`Run ${run.index}`)}</span>
          <span class="agent-row-subtitle">${escapeHtml(subtitle || run.title)}</span>
        </span>
        <span class="agent-row-meta">
          ${imageChip}
          ${renderAgentStatusChip(run.status)}
          ${inspectButton}
        </span>
      </summary>
      ${renderSentPromptIcon(run.sentPromptRowIndex)}
      <div class="agent-run-children">
        ${userImagesStrip}
        ${run.errors.map((item) => renderAgentOutputItem(item, 0)).join("")}
        ${run.steps.map((step, stepIdx) => renderReactStepNode(step, 0, { isOnlyStep: run.steps.length === 1, isLatestStep: stepIdx === run.steps.length - 1 })).join("")}
        ${!run.steps.length && !run.errors.length ? `<div class="agent-detail-empty">No model output in this run yet.</div>` : ""}
      </div>
    </details>`;
}

function renderReactStepNode(step, depth = 0, options = {}) {
  const toolNames = step.tools.map((tool) => tool.name);
  const titleBits = [
    step.thinking.length ? "Thinking" : "",
    step.tools.length ? `${step.tools.length} tool${step.tools.length === 1 ? "" : "s"}` : "",
    step.response.length ? "Response" : "",
  ].filter(Boolean);
  const subtitle = [
    titleBits.join(" + ") || "Model output",
    toolNames.slice(0, 4).join(", "),
  ].filter(Boolean).join(" · ");
  const isOpen = step.status === "error" || options.isOnlyStep || options.isLatestStep;
  return `
    <details class="agent-row react-step" data-status="${escapeAttr(step.status)}" style="--depth: ${depth}" ${isOpen ? "open" : ""}>
      <summary class="agent-row-summary">
        ${renderAgentAnchor()}
        ${renderAgentChip("react_step", step.status)}
        <span class="agent-row-copy">
          <span class="agent-row-title">${escapeHtml(step.title)}</span>
          <span class="agent-row-subtitle">${escapeHtml(subtitle)}</span>
        </span>
        <span class="agent-row-meta">
          ${renderAgentStatusChip(step.status)}
        </span>
      </summary>
      <div class="agent-row-children">
        ${step.errors.map((item) => renderAgentOutputItem(item, depth + 1)).join("")}
        ${step.thinking.map((item) => renderAgentOutputItem(item, depth + 1)).join("")}
        ${step.tools.map((tool) => renderToolCallNode(tool, depth + 1)).join("")}
        ${step.response.map((item) => renderAgentOutputItem(item, depth + 1)).join("")}
      </div>
    </details>`;
}

function renderToolCallNode(tool, depth = 0) {
  const inputPreview = summarizeToolInput(tool.input);
  const inspectButton = tool.result?.messageIndex !== undefined
    ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${tool.result.messageIndex}">Inspect</button>`
    : "";
  return `
    <details class="agent-row tool-call" data-status="${escapeAttr(tool.status)}" style="--depth: ${depth}">
      <summary class="agent-row-summary">
        ${renderAgentAnchor()}
        ${renderAgentChip("tool", tool.status)}
        <span class="agent-row-copy">
          <span class="agent-row-title">${escapeHtml(tool.name)}</span>
          <span class="agent-row-subtitle">${escapeHtml(inputPreview || "No input captured")}</span>
        </span>
        <span class="agent-row-meta">
          ${renderAgentStatusChip(tool.status)}
          ${inspectButton}
        </span>
      </summary>
      <div class="agent-row-detail" style="--depth: ${depth}">
        ${tool.request ? renderToolSection("Input", tool.input || tool.request.content?.input || {}) : ""}
        ${tool.detected ? renderToolSection("Detected", tool.detected.content || {}) : ""}
        ${tool.result ? renderToolSection("Result", tool.result.content || {}) : `<div class="agent-detail-empty">Tool result pending.</div>`}
      </div>
    </details>`;
}

function renderToolSection(label, value) {
  const safeValue = sanitizeImagesForDebugDump(value);
  return `
    <section class="agent-detail-section">
      <div class="agent-detail-section-title">${escapeHtml(label)}</div>
      <pre class="agent-detail-pre">${escapeHtml(formatOutputValue(safeValue))}</pre>
    </section>`;
}

function renderAgentOutputItem(item, depth = 0) {
  const config = agentOutputItemConfig(item);
  const inspectButton = item.messageIndex !== undefined
    ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${item.messageIndex}">Inspect</button>`
    : "";
  return `
    <details class="agent-row agent-detail-node ${escapeAttr(item.type)}" data-status="${escapeAttr(config.status)}" style="--depth: ${depth}">
      <summary class="agent-row-summary">
        ${renderAgentAnchor()}
        ${renderAgentChip(config.chipType, config.status)}
        <span class="agent-row-copy">
          <span class="agent-row-title">${escapeHtml(config.title)}</span>
          <span class="agent-row-subtitle">${escapeHtml(config.preview)}</span>
        </span>
        <span class="agent-row-meta">
          ${inspectButton}
        </span>
      </summary>
      <div class="agent-row-detail" style="--depth: ${depth}">
        ${config.body}
      </div>
    </details>`;
}

function agentOutputItemConfig(item) {
  if (item.type === "thinking") {
    const text = item.text || item.content?.thinking || "";
    return {
      title: "Thinking",
      chipType: "thinking",
      status: "success",
      preview: summarizeMessageText(text),
      body: `<div class="agent-detail-text">${escapeHtml(text)}</div>`,
    };
  }
  if (item.type === "response") {
    const text = item.text || item.content?.text || formatOutputValue(item.content);
    return {
      title: "Response",
      chipType: "response",
      status: "success",
      preview: summarizeMessageText(text),
      body: `<div class="agent-detail-text">${escapeHtml(text)}</div>`,
    };
  }
  if (item.type === "error") {
    const text = item.text || item.content?.label || item.content?.data?.message || "Unknown error";
    return {
      title: "Runtime error",
      chipType: "error",
      status: "error",
      preview: summarizeMessageText(text),
      body: `<div class="agent-detail-text">${escapeHtml(text)}</div>`,
    };
  }
  return {
    title: item.type,
    chipType: item.type,
    status: "success",
    preview: summarizeMessageText(formatOutputValue(item.content)),
    body: `<pre class="agent-detail-pre">${escapeHtml(formatOutputValue(item.content))}</pre>`,
  };
}

function renderAgentAnchor({ withHook = true } = {}) {
  return `<span class="agent-row-anchor${withHook ? "" : " no-hook"}" aria-hidden="true"><span class="agent-row-chevron"></span></span>`;
}

function renderAgentChip(chipType, status = "success") {
  const entry = AGENT_OUTPUT_CHIP_TONES[chipType];
  if (!entry) {
    return `<span class="agent-chip" data-tone="default">${escapeHtml(String(chipType || "").toUpperCase())}</span>`;
  }
  const tone = status === "error" ? "error" : entry.tone;
  return `<span class="agent-chip" data-tone="${escapeAttr(tone)}">${escapeHtml(entry.label)}</span>`;
}

function renderAgentStatusChip(status = "success") {
  const entry = AGENT_STATUS_CHIP_TONES[status] || AGENT_STATUS_CHIP_TONES.success;
  return `<span class="agent-status-chip" data-tone="${escapeAttr(entry.tone)}" data-status="${escapeAttr(status)}">${escapeHtml(entry.label)}</span>`;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input);
  if (!entries.length) return "";
  const [key, value] = entries[0];
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return `${key}: ${rendered}`;
}

function formatOutputValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {}, null, 2);
}
