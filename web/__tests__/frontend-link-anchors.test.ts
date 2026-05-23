import { describe, expect, test } from "bun:test";

import { buildAgentOutputGraph, renderAgentOutputGraph } from "../public/view/agent-output-graph.js";
import { renderTimelineHTML } from "../public/view/timeline.js";

// UI-2 (canonical): chat-thread ↔ timeline 通过 data-node-id / data-node-scope 单一锚点联动。
describe("UI-2 chat-thread ↔ timeline link anchors (canonical)", () => {
  test("L1 user-bubble carries data-node-id=message:<reqId>:user:<seq> + data-node-scope=run:<reqId>", () => {
    const graph: any = buildAgentOutputGraph([
      {
        type: "message",
        requestId: "req-1",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    const html = renderAgentOutputGraph(graph);
    expect(html).toContain('class="user-bubble"');
    expect(html).toMatch(/data-node-id="message:req-1:user:\d+"/);
    expect(html).toContain('data-node-scope="run:req-1"');
  });

  test("L2 agent-turn carries data-node-id=agent:<reqId>:lead + data-node-scope=run:<reqId>", () => {
    const graph: any = buildAgentOutputGraph([
      {
        type: "message",
        requestId: "req-2",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "model_output_block",
        requestId: "req-2",
        data: { block: { type: "text", text: "answer" } },
      },
    ]);
    const html = renderAgentOutputGraph(graph);
    expect(html).toContain('class="agent-turn"');
    expect(html).toContain('data-node-id="agent:req-2:lead"');
    expect(html).toContain('data-node-scope="run:req-2"');
  });

  test("L3 trail-tool carries data-node-id=tool:<toolUseId> + data-node-scope=step:<...>", () => {
    const graph: any = buildAgentOutputGraph([
      {
        type: "message",
        requestId: "req-3",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "model_output_block",
        requestId: "req-3",
        data: { block: { type: "tool_use", id: "tu-abc", name: "bash", input: { command: "pwd" } } },
      },
    ]);
    const html = renderAgentOutputGraph(graph);
    expect(html).toContain('data-node-id="tool:tu-abc"');
    expect(html).toContain('data-node-scope="step:req-3:lead:1"');
  });

  test("L4 final-answer carries data-node-id=response:... + data-node-scope=step:<...>", () => {
    const graph: any = buildAgentOutputGraph([
      {
        type: "message",
        requestId: "req-4",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "model_output_block",
        requestId: "req-4",
        data: { block: { type: "text", text: "the final answer" } },
      },
    ]);
    const html = renderAgentOutputGraph(graph);
    expect(html).toContain('class="final-answer"');
    expect(html).toMatch(/<div class="final-answer" data-node-id="response:\d+:\d+:\d+" data-node-scope="step:req-4:lead:\d+"/);
  });

  test("L5 timeline run/agent/step nodes mirror canonical data-node-id namespace", () => {
    const events = [
      {
        kind: "hook_triggered",
        requestId: "req-5",
        at: "2026-05-23T10:00:00.000Z",
        label: "beforeAgentStep",
        data: { hook: "beforeAgentStep", step: 1 },
        graph: { step: 1 },
      },
    ];
    const html = renderTimelineHTML(events as any, "all");
    expect(html).toContain('data-node-id="run:req-5"');
    expect(html).toContain('data-node-id="agent:req-5:lead"');
    expect(html).toContain('data-node-id="step:req-5:lead:1"');
    expect(html).toContain('data-node-scope="step:req-5:lead:1"');
  });

  test("L6 timeline tool event mirrors data-node-id=tool:<toolUseId> (cross-pane shared)", () => {
    const events = [
      {
        kind: "tool_execution_started",
        requestId: "req-6",
        at: "2026-05-23T10:00:00.000Z",
        label: "Tool started",
        data: { toolName: "bash", toolUseId: "tu-xyz" },
      },
    ];
    const html = renderTimelineHTML(events as any, "all");
    expect(html).toContain('data-node-id="tool:tu-xyz"');
  });
});
