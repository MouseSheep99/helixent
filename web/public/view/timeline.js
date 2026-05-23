import { extractImagesFromEvent, renderThumbnailStrip, sanitizeImagesForDebugDump } from "./images.js";
import { compactTimelineEvents, friendlyTimelineKind, shouldShowTimelineEvent, timelineBadge } from "./timeline-legacy.js";
import { escapeAttr, escapeHtml, formatTime } from "./utils.js";

export function renderTimelineHTML(events = [], filter = "all") {
  const graph = buildTimelineGraph(events);
  const visibleGraph = filterTimelineGraph(graph, filter);
  if (!visibleGraph.roots.length) return `<div class="empty-state">No hook or tool timeline yet.</div>`;
  return renderTimelineGraphHTML(visibleGraph, filter);
}

const TIMELINE_PHASE_ORDER = [
  "prompt_phase",
  "skills",
  "memory",
  "model_call",
  "tool_planning",
  "tool_execution",
  "mcp",
  "human_gate",
  "todo",
  "errors",
  "unscoped",
];

const TIMELINE_PHASE_TITLES = {
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

export function buildTimelineGraph(events = []) {
  const graph = {
    roots: [],
    nodeById: {},
    diagnostics: [],
  };
  const session = createTimelineSessionNode();
  const runs = new Map();
  const compactedEvents = compactTimelineEvents(events).slice(-160);

  for (const event of compactedEvents) {
    if (!event?.kind) continue;
    if (!event.requestId) {
      appendTimelineChild(graph, session, createTimelineEventNode(event));
      continue;
    }

    const run = getOrCreateTimelineRun(graph, runs, event);
    if (event.kind === "session_aborted") {
      appendTimelineChild(graph, run, createTimelineEventNode(event));
      updateTimelineRunStatus(run, event);
      continue;
    }

    const agent = getOrCreateTimelineAgentExecution(graph, run, event);
    if (isAgentExecutionEvent(event)) {
      appendTimelineChild(graph, agent, createTimelineEventNode(event));
      updateTimelineAgentStatus(agent, event);
      updateTimelineRunStatus(run, event);
      continue;
    }

    const step = getOrCreateTimelineStep(graph, agent, event);
    const phase = getOrCreateTimelinePhase(graph, step, phaseForTimelineEvent(event));
    appendTimelineChild(graph, phase, createTimelineEventNode(event));
    updateTimelineStepStatus(step, event);
    updateTimelineAgentStatus(agent, event);
    updateTimelineRunStatus(run, event);
  }

  if (session.children.length) {
    graph.roots.push(session);
    graph.nodeById[session.id] = session;
  }
  graph.roots.push(...Array.from(runs.values()));
  finalizeTimelineGraph(graph);
  return graph;
}

function createTimelineSessionNode() {
  return {
    id: "session",
    type: "session",
    title: "Workspace / Session Events",
    status: "success",
    children: [],
    events: [],
  };
}

function getOrCreateTimelineRun(graph, runs, event) {
  const requestId = event.requestId || `synthetic-${runs.size + 1}`;
  if (runs.has(requestId)) return runs.get(requestId);
  const run = {
    id: `run:${requestId}`,
    type: "run",
    requestId,
    runIndex: runs.size + 1,
    title: `Run ${runs.size + 1}`,
    startedAt: event.at,
    endedAt: event.at,
    durationMs: undefined,
    status: "running",
    children: [],
    events: [],
    agentExecutions: new Map(),
  };
  runs.set(requestId, run);
  graph.nodeById[run.id] = run;
  return run;
}

function getOrCreateTimelineAgentExecution(graph, run, event) {
  const refs = event.graph?.refs || {};
  const agentId = String(refs.agentId || event.data?.agentId || "lead");
  const agentRole = refs.agentRole || event.data?.agentRole || (agentId === "lead" ? "lead" : "sub");
  if (run.agentExecutions.has(agentId)) return run.agentExecutions.get(agentId);
  const agent = {
    id: `agent:${run.requestId || run.runIndex}:${agentId}`,
    type: "agent_execution",
    requestId: run.requestId,
    agentId,
    parentAgentId: refs.parentAgentId || event.data?.parentAgentId,
    agentRole,
    title: agentRole === "lead" ? "Lead agent" : `Sub-agent: ${agentId}`,
    startedAt: event.at,
    endedAt: event.at,
    durationMs: undefined,
    status: "running",
    children: [],
    events: [],
    steps: new Map(),
    currentStep: null,
  };
  run.agentExecutions.set(agentId, agent);
  appendTimelineChild(graph, run, agent);
  return agent;
}

function getOrCreateTimelineStep(graph, agent, event) {
  const explicitStep = event.graph?.step ?? event.data?.step;
  const stepNumber = Number.isFinite(Number(explicitStep)) ? Number(explicitStep) : agent.currentStep || 1;
  if (agent.steps.has(stepNumber)) {
    const existing = agent.steps.get(stepNumber);
    if (isBeforeAgentStepEvent(event)) agent.currentStep = stepNumber;
    return existing;
  }
  const step = {
    id: `step:${agent.requestId || "session"}:${agent.agentId}:${stepNumber}`,
    type: "react_step",
    requestId: agent.requestId,
    agentId: agent.agentId,
    step: stepNumber,
    title: `Step ${stepNumber}`,
    startedAt: event.at,
    endedAt: event.at,
    durationMs: undefined,
    status: "running",
    children: [],
    events: [],
    phases: new Map(),
  };
  agent.steps.set(stepNumber, step);
  agent.currentStep = stepNumber;
  appendTimelineChild(graph, agent, step);
  return step;
}

function getOrCreateTimelinePhase(graph, step, phaseType) {
  const type = TIMELINE_PHASE_ORDER.includes(phaseType) ? phaseType : "unscoped";
  if (step.phases.has(type)) return step.phases.get(type);
  const phase = {
    id: `phase:${step.id}:${type}`,
    type,
    title: TIMELINE_PHASE_TITLES[type] || friendlyTimelineKind(type),
    status: "success",
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
    children: [],
    events: [],
  };
  step.phases.set(type, phase);
  appendTimelineChild(graph, step, phase);
  sortTimelinePhaseChildren(step);
  return phase;
}

function createTimelineEventNode(event) {
  return {
    id: `event:${event.id || `${event.kind}:${event.at || Math.random()}`}`,
    type: "event",
    kind: event.kind,
    category: classifyTimelineEvent(event),
    title: event.label || friendlyTimelineKind(event.kind),
    subtitle: timelineEventSubtitle(event),
    badge: timelineBadge(event),
    at: event.at,
    status: statusForTimelineEvent(event),
    event,
    children: [],
  };
}

function appendTimelineChild(graph, parent, child) {
  parent.children.push(child);
  graph.nodeById[child.id] = child;
  if (child.event) parent.events.push(child.event);
  if (child.startedAt) {
    parent.startedAt = earliestTimelineAt(parent.startedAt, child.startedAt);
    parent.endedAt = latestTimelineAt(parent.endedAt, child.endedAt || child.startedAt);
  }
}

function sortTimelinePhaseChildren(step) {
  step.children.sort((a, b) => TIMELINE_PHASE_ORDER.indexOf(a.type) - TIMELINE_PHASE_ORDER.indexOf(b.type));
}

function finalizeTimelineGraph(graph) {
  walkTimelineNodes(graph.roots, (node) => {
    if (node.startedAt && node.endedAt) node.durationMs = durationMs(node.startedAt, node.endedAt);
    if (node.type === "run" || node.type === "agent_execution" || node.type === "react_step") {
      node.events = collectTimelineEvents(node);
    }
    if (node.type === "run") delete node.agentExecutions;
    if (node.type === "agent_execution") {
      delete node.steps;
      delete node.currentStep;
    }
    if (node.type === "react_step") delete node.phases;
  });
}

function walkTimelineNodes(nodes, visitor) {
  for (const node of nodes) {
    if (node.children?.length) walkTimelineNodes(node.children, visitor);
    visitor(node);
  }
}

function collectTimelineEvents(node) {
  if (node.type === "event") return [node.event];
  return (node.children || []).flatMap(collectTimelineEvents);
}

function updateTimelineRunStatus(run, event) {
  run.startedAt = earliestTimelineAt(run.startedAt, event.at);
  run.endedAt = latestTimelineAt(run.endedAt, event.at);
  if (event.kind === "error") run.status = "error";
  else if (event.kind === "session_aborted") run.status = "aborted";
  else if (isHookEvent(event, "afterAgentRun") && run.status !== "error") run.status = "success";
}

function updateTimelineAgentStatus(agent, event) {
  agent.startedAt = earliestTimelineAt(agent.startedAt, event.at);
  agent.endedAt = latestTimelineAt(agent.endedAt, event.at);
  if (event.kind === "error" || isFailedToolEvent(event)) agent.status = "error";
  else if (isHookEvent(event, "afterAgentRun") && agent.status !== "error") agent.status = "success";
}

function updateTimelineStepStatus(step, event) {
  step.startedAt = earliestTimelineAt(step.startedAt, event.at);
  step.endedAt = latestTimelineAt(step.endedAt, event.at);
  if (event.kind === "error" || isFailedToolEvent(event)) step.status = "error";
  else if (isHookEvent(event, "afterAgentStep") && step.status !== "error") step.status = "success";
}

function earliestTimelineAt(current, next) {
  if (!current) return next;
  if (!next) return current;
  return new Date(next).getTime() < new Date(current).getTime() ? next : current;
}

function latestTimelineAt(current, next) {
  if (!current) return next;
  if (!next) return current;
  return new Date(next).getTime() > new Date(current).getTime() ? next : current;
}

function durationMs(startedAt, endedAt) {
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

function isHookEvent(event, hook) {
  return event.kind === "hook_triggered" && event.data?.hook === hook;
}

function isBeforeAgentStepEvent(event) {
  return isHookEvent(event, "beforeAgentStep");
}

function isAgentExecutionEvent(event) {
  return isHookEvent(event, "beforeAgentRun") || isHookEvent(event, "afterAgentRun");
}

function isFailedToolEvent(event) {
  return event.kind === "tool_execution_completed" && (event.data?.error || event.data?.ok === false);
}

function classifyTimelineEvent(event) {
  if (event.kind === "hook_triggered") return "hook";
  if (["input_context", "model_output_block", "token_usage", "agent_progress"].includes(event.kind)) return "model";
  if (["tool_call_detected", "tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(event.kind)) return "tool";
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(event.kind)) return "human";
  if (["skills_inventory", "skill_system_injected", "skill_loaded"].includes(event.kind)) return "skill";
  if (event.kind?.startsWith("prompt_version_")) return "prompt";
  if (event.kind === "todo_update") return "todo";
  if (event.kind === "error") return "error";
  if (event.kind?.startsWith("mcp_")) return "mcp";
  if (event.kind?.startsWith("memory_")) return "memory";
  return "session";
}

function phaseForTimelineEvent(event) {
  if (event.kind === "error") return "errors";
  if (event.kind === "prompt_version_applied" || event.kind === "input_context") return "prompt_phase";
  if (["skills_inventory", "skill_system_injected", "skill_loaded"].includes(event.kind)) return "skills";
  if (event.kind?.startsWith("memory_")) return "memory";
  if (event.kind?.startsWith("mcp_")) return "mcp";
  if (event.kind === "hook_triggered") {
    if (["beforeModel", "afterModel"].includes(event.data?.hook)) return "model_call";
    if (["beforeToolUse", "afterToolUse"].includes(event.data?.hook)) return "tool_execution";
    return "unscoped";
  }
  if (["model_output_block", "token_usage", "agent_progress"].includes(event.kind)) return event.data?.progress?.subtype === "tool" ? "tool_execution" : "model_call";
  if (event.kind === "tool_call_detected") return "tool_planning";
  if (["tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(event.kind)) return "tool_execution";
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(event.kind)) return "human_gate";
  if (event.kind === "todo_update") return "todo";
  return "unscoped";
}

function statusForTimelineEvent(event) {
  if (event.kind === "error" || isFailedToolEvent(event)) return "error";
  if (event.kind === "tool_execution_started" || event.kind === "approval_requested" || event.kind === "question_requested") return "running";
  if (event.kind === "tool_disabled") return "skipped";
  return "success";
}

function timelineEventSubtitle(event) {
  if (event.kind === "hook_triggered") return event.data?.hook || friendlyTimelineKind(event.kind);
  if (event.kind === "model_output_block") return event.data?.block?.type || "model block";
  if (event.kind === "agent_progress") return event.data?.progress?.name || event.data?.progress?.subtype || "progress";
  if (event.kind === "tool_call_detected") return event.data?.toolUse?.name || "tool call";
  if (event.kind === "tool_execution_started" || event.kind === "tool_execution_completed") return event.data?.toolName || event.data?.name || "tool";
  if (event.kind === "input_context") {
    const imageCount = extractImagesFromEvent(event).length;
    if (imageCount > 0) return `input_context · 📎 ${imageCount} image${imageCount === 1 ? "" : "s"}`;
  }
  return friendlyTimelineKind(event.kind);
}

function filterTimelineGraph(graph, filter = "all") {
  const nodeById = {};
  const roots = graph.roots.map((node) => filterTimelineNode(node, filter, nodeById)).filter(Boolean);
  return { roots, nodeById, diagnostics: graph.diagnostics || [] };
}

function filterTimelineNode(node, filter, nodeById) {
  if (node.type === "event") {
    if (!shouldShowTimelineEvent(node.event, filter)) return null;
    const clonedEvent = { ...node, children: [] };
    nodeById[clonedEvent.id] = clonedEvent;
    return clonedEvent;
  }
  const children = (node.children || []).map((child) => filterTimelineNode(child, filter, nodeById)).filter(Boolean);
  if (!children.length) return null;
  const cloned = { ...node, children };
  nodeById[cloned.id] = cloned;
  return cloned;
}

function renderTimelineGraphHTML(graph, filter = "all") {
  return `<div class="timeline-graph" data-filter="${escapeAttr(filter)}">${graph.roots.map((node, index) => renderTimelineNode(node, 0, { isLatestRun: index === graph.roots.length - 1 })).join("")}</div>`;
}

function renderTimelineNode(node, depth = 0, options = {}) {
  if (node.type === "event") return renderTimelineEventNode(node, depth);
  const open = shouldOpenTimelineNode(node, options);
  const summary = timelineNodeSummary(node);
  return `
    <details class="timeline-node timeline-${escapeAttr(node.type)}-node ${escapeAttr(node.status || "success")}" ${open ? "open" : ""}>
      <summary class="timeline-node-row" style="--depth: ${depth}">
        <span class="timeline-tree-line" aria-hidden="true"></span>
        <span class="timeline-type-chip ${escapeAttr(timelineNodeTone(node))}">${escapeHtml(summary.chip)}</span>
        <span class="timeline-node-title">${escapeHtml(summary.title)}</span>
        <span class="timeline-node-meta">${escapeHtml(summary.meta)}</span>
      </summary>
      <div class="timeline-graph-children">
        ${(node.children || []).map((child) => renderTimelineNode(child, depth + 1, options)).join("")}
      </div>
    </details>`;
}

function renderTimelineEventNode(node, depth = 0) {
  const event = node.event;
  const count = event.count || event.data?.count;
  const safeData = sanitizeImagesForDebugDump(event.data || {});
  const images = extractImagesFromEvent(event);
  const stripHtml = images.length
    ? `<div class="timeline-event-images">${renderThumbnailStrip(images, { size: 56, group: `timeline-${node.id}` })}</div>`
    : "";
  return `
    <details class="timeline-node timeline-event-node ${escapeAttr(node.category)} ${escapeAttr(node.status || "success")}" ${shouldOpenTimelineEvent(node) ? "open" : ""}>
      <summary class="timeline-node-row" style="--depth: ${depth}">
        <span class="timeline-tree-line" aria-hidden="true"></span>
        <span class="timeline-type-chip ${escapeAttr(node.category)}">${escapeHtml(timelineEventChip(node))}</span>
        <span class="timeline-node-title">${escapeHtml(node.title)}</span>
        <span class="timeline-node-meta">${escapeHtml([node.subtitle, count ? `x${count}` : "", formatTime(event.at)].filter(Boolean).join(" · "))}</span>
      </summary>
      <pre class="timeline-graph-detail">${escapeHtml(JSON.stringify(safeData, null, 2))}</pre>
      ${stripHtml}
    </details>`;
}

function shouldOpenTimelineNode(node, options = {}) {
  if (node.type === "session") return node.status === "error";
  if (node.type === "run") return options.isLatestRun || node.status === "error" || node.status === "aborted";
  if (node.type === "agent_execution") return node.agentRole === "lead" || node.status === "error";
  if (node.type === "react_step") return node.status === "error";
  return true;
}

function shouldOpenTimelineEvent(node) {
  return node.status === "error" || ["approval_requested", "question_requested"].includes(node.kind);
}

function timelineNodeSummary(node) {
  if (node.type === "session") {
    return { chip: "SESSION", title: node.title, meta: `${countTimelineEvents(node)} events` };
  }
  if (node.type === "run") {
    return {
      chip: "RUN",
      title: node.title,
      meta: `${countTimelineNodes(node, "agent_execution")} agent · ${countTimelineNodes(node, "react_step")} steps · ${countTimelineCategory(node, "tool")} tools${formatDurationSuffix(node.durationMs)}`,
    };
  }
  if (node.type === "agent_execution") {
    return {
      chip: node.agentRole === "lead" ? "LEAD" : "AGENT",
      title: node.title,
      meta: `${countTimelineNodes(node, "react_step")} steps · ${countTimelineCategory(node, "tool")} tools${formatDurationSuffix(node.durationMs)}`,
    };
  }
  if (node.type === "react_step") {
    return {
      chip: "STEP",
      title: node.title,
      meta: `${countTimelineCategory(node, "model")} model · ${countTimelineCategory(node, "tool")} tools · ${countTimelineCategory(node, "human")} human${formatDurationSuffix(node.durationMs)}`,
    };
  }
  return {
    chip: phaseChip(node.type),
    title: node.title,
    meta: `${countTimelineEvents(node)} events${formatDurationSuffix(node.durationMs)}`,
  };
}

function timelineNodeTone(node) {
  if (node.type === "session") return "session";
  if (node.type === "run") return "run";
  if (node.type === "agent_execution") return "agent";
  if (node.type === "react_step") return "step";
  if (node.type === "prompt_phase") return "prompt";
  if (node.type === "model_call") return "model";
  if (node.type === "tool_planning" || node.type === "tool_execution") return "tool";
  if (node.type === "human_gate") return "human";
  if (node.type === "skills") return "skill";
  if (node.type === "memory") return "memory";
  if (node.type === "mcp") return "mcp";
  if (node.type === "todo") return "todo";
  if (node.type === "errors") return "error";
  return "session";
}

function phaseChip(type) {
  const labels = {
    prompt_phase: "PROMPT",
    skills: "SKILL",
    memory: "MEM",
    model_call: "MODEL",
    tool_planning: "PLAN",
    tool_execution: "TOOL",
    mcp: "MCP",
    human_gate: "HUMAN",
    todo: "TODO",
    errors: "ERROR",
    unscoped: "OTHER",
  };
  return labels[type] || "PHASE";
}

function timelineEventChip(node) {
  if (node.category === "hook") return "HOOK";
  if (node.category === "model") return "MODEL";
  if (node.category === "tool") return "TOOL";
  if (node.category === "human") return "HUMAN";
  if (node.category === "skill") return "SKILL";
  if (node.category === "prompt") return "PROMPT";
  if (node.category === "todo") return "TODO";
  if (node.category === "error") return "ERROR";
  if (node.category === "memory") return "MEM";
  if (node.category === "mcp") return "MCP";
  return "EVENT";
}

function countTimelineNodes(node, type) {
  if (node.type === type) return 1;
  return (node.children || []).reduce((total, child) => total + countTimelineNodes(child, type), 0);
}

function countTimelineCategory(node, category) {
  if (node.type === "event") return node.category === category ? 1 : 0;
  return (node.children || []).reduce((total, child) => total + countTimelineCategory(child, category), 0);
}

function countTimelineEvents(node) {
  return node.type === "event" ? 1 : (node.children || []).reduce((total, child) => total + countTimelineEvents(child), 0);
}

function formatDurationSuffix(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return ` · ${value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`}`;
}
