// Canonical event graph entry: single source-of-truth for chat-thread + timeline views.
// Both views share stable nodeId rules so link.js can do data-node-id / data-node-scope
// based bidirectional highlighting across panes.
//
// nodeId naming convention (see canonical-graph-unification-plan.md §3.1.1):
//   run:<requestId>                          (synthetic-N when requestId missing)
//   agent:<requestId>:<agentId>
//   step:<requestId>:<agentId>:<n>
//   phase:<requestId>:<agentId>:<n>:<phase>  (timeline only)
//   tool:<toolUseId>                         (cross-view shared)
//   thinking:<runIdx>:<stepIdx>:<k>
//   response:<runIdx>:<stepIdx>:<k>
//   error:<rowId | eventId>
//   event:<eventId>                          (timeline only)
//   message:<requestId>:<role>:<seq>         (cross-view shared)

import { buildAgentOutputGraph } from "./agent-output-graph.js";
import { buildTimelineGraph } from "./timeline.js";

export function buildCanonicalEventGraph(rows = []) {
  // The canonical graph is the union of inputs needed by both downstream views.
  // We keep `rows` as the truth feed and pre-compute both view graphs so that
  // selectors are pure projections. Each underlying builder already attaches
  // stable nodeId/scopeId on every node, satisfying the canonical contract.
  const events = Array.isArray(rows)
    ? rows.filter((row) => row && typeof row === "object" && row.kind)
    : [];
  return {
    rows,
    events,
    agentOutput: buildAgentOutputGraph(rows),
    timeline: buildTimelineGraph(events),
  };
}

export function selectAgentOutputView(canonical) {
  return canonical?.agentOutput || buildAgentOutputGraph(canonical?.rows || []);
}

export function selectTimelineView(canonical) {
  return canonical?.timeline || buildTimelineGraph(canonical?.events || []);
}
