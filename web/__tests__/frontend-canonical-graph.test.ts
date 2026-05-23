import { describe, expect, test } from "bun:test";

import {
  buildCanonicalEventGraph,
  selectAgentOutputView,
  selectTimelineView,
} from "../public/view/canonical-graph.js";

// canonical-graph 单一真相源：buildCanonicalEventGraph(rows) 既驱动 chat-thread 也驱动 timeline，
// 两个 selector 输出的 graph 形状必须与现有契约保持一致，并且两侧共享稳定 nodeId/scopeId。

function makeFixture() {
  return [
    // user turn (output side)
    {
      type: "message",
      requestId: "req-A",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    // user_message timeline event (timeline side)
    {
      kind: "user_message",
      requestId: "req-A",
      at: "2026-05-23T10:00:00.000Z",
      data: { content: [{ type: "text", text: "hello" }] },
    },
    // beforeAgentStep hook → opens step 1 on timeline
    {
      kind: "hook_triggered",
      requestId: "req-A",
      at: "2026-05-23T10:00:01.000Z",
      label: "beforeAgentStep",
      data: { hook: "beforeAgentStep", step: 1 },
      graph: { step: 1 },
    },
    // tool_use block on output side
    {
      kind: "model_output_block",
      requestId: "req-A",
      at: "2026-05-23T10:00:02.000Z",
      data: {
        block: { type: "tool_use", id: "tu-shared", name: "bash", input: { command: "pwd" } },
      },
    },
    // matching tool_execution_started on timeline side (same toolUseId)
    {
      kind: "tool_execution_started",
      requestId: "req-A",
      at: "2026-05-23T10:00:03.000Z",
      label: "Tool started",
      data: { toolName: "bash", toolUseId: "tu-shared" },
    },
    // final text response
    {
      kind: "model_output_block",
      requestId: "req-A",
      at: "2026-05-23T10:00:04.000Z",
      data: { block: { type: "text", text: "done" } },
    },
  ];
}

describe("canonical event graph", () => {
  test("C1 buildCanonicalEventGraph emits stable nodeId across rebuilds", () => {
    const rows = makeFixture();
    const a = buildCanonicalEventGraph(rows);
    const b = buildCanonicalEventGraph(rows);
    const aOut = selectAgentOutputView(a);
    const bOut = selectAgentOutputView(b);
    expect(aOut.runs[0].nodeId).toBe(bOut.runs[0].nodeId);
    expect(aOut.runs[0].steps[0].nodeId).toBe(bOut.runs[0].steps[0].nodeId);
    expect(aOut.runs[0].steps[0].tools[0].nodeId).toBe(bOut.runs[0].steps[0].tools[0].nodeId);
    const aTl = selectTimelineView(a);
    const bTl = selectTimelineView(b);
    expect(aTl.roots[0].nodeId).toBe(bTl.roots[0].nodeId);
  });

  test("C2 selectAgentOutputView preserves graph.runs / nodeById / systemErrors contract", () => {
    const canonical = buildCanonicalEventGraph(makeFixture());
    const graph: any = selectAgentOutputView(canonical);
    expect(Array.isArray(graph.runs)).toBe(true);
    expect(graph.systemErrors).toBeDefined();
    expect(graph.nodeById).toBeDefined();
    // tool node looked up by canonical key
    expect(graph.nodeById["tool:tu-shared"]).toBeDefined();
    expect(graph.nodeById["tool:tu-shared"].type).toBe("tool");
    // run shape preserved
    const run = graph.runs[0];
    expect(run.type).toBe("run");
    expect(run.steps.length).toBeGreaterThanOrEqual(1);
  });

  test("C3 selectTimelineView preserves graph.roots run/agent/step/phase contract", () => {
    const canonical = buildCanonicalEventGraph(makeFixture());
    const graph: any = selectTimelineView(canonical);
    const run = graph.roots.find((n: any) => n.type === "run");
    expect(run).toBeDefined();
    expect(run.nodeId).toBe("run:req-A");
    const agent = run.children.find((n: any) => n.type === "agent_execution");
    expect(agent).toBeDefined();
    expect(agent.nodeId).toBe("agent:req-A:lead");
    const step = agent.children.find((n: any) => n.type === "react_step");
    expect(step).toBeDefined();
    expect(step.nodeId).toBe("step:req-A:lead:1");
    const phase = step.children.find((n: any) => n.type !== "event");
    expect(phase).toBeDefined();
    expect(typeof phase.nodeId).toBe("string");
    expect(phase.nodeId.startsWith("phase:req-A:lead:1:")).toBe(true);
  });

  test("C4 same toolUseId shares nodeId across output view and timeline view", () => {
    const canonical = buildCanonicalEventGraph(makeFixture());
    const out: any = selectAgentOutputView(canonical);
    const tl: any = selectTimelineView(canonical);
    const outTool = out.runs[0].steps[0].tools[0];
    expect(outTool.nodeId).toBe("tool:tu-shared");

    // Find the matching event node in timeline.
    function findTool(node: any): any {
      if (node.nodeId === "tool:tu-shared") return node;
      for (const child of node.children || []) {
        const found = findTool(child);
        if (found) return found;
      }
      return null;
    }
    const tlTool = tl.roots.map(findTool).find(Boolean);
    expect(tlTool).toBeDefined();
    expect(tlTool.nodeId).toBe(outTool.nodeId);
  });

  test("C5 user_message timeline event lands in user_input phase with step scope", () => {
    const canonical = buildCanonicalEventGraph(makeFixture());
    const tl: any = selectTimelineView(canonical);
    const run = tl.roots.find((n: any) => n.type === "run");
    const agent = run.children.find((n: any) => n.type === "agent_execution");
    const step = agent.children.find((n: any) => n.type === "react_step");
    const userInputPhase = step.children.find((n: any) => n.type === "user_input");
    expect(userInputPhase).toBeDefined();
    expect(userInputPhase.scopeId).toBe(step.nodeId);
    const userEvent = userInputPhase.children.find((n: any) => n.kind === "user_message");
    expect(userEvent).toBeDefined();
    // Inherited scope should chain back to the enclosing step.
    expect(userEvent.scopeId).toBe(step.nodeId);
  });

  test("C6 phase node carries nodeId=phase:... and scopeId=step:...", () => {
    const canonical = buildCanonicalEventGraph(makeFixture());
    const tl: any = selectTimelineView(canonical);
    const run = tl.roots.find((n: any) => n.type === "run");
    const agent = run.children.find((n: any) => n.type === "agent_execution");
    const step = agent.children.find((n: any) => n.type === "react_step");
    for (const phase of step.children) {
      expect(phase.nodeId.startsWith("phase:")).toBe(true);
      expect(phase.scopeId).toBe(step.nodeId);
    }
  });
});
