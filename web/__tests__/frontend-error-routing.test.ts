import { describe, expect, test } from "bun:test";

import { buildAgentOutputGraph } from "../public/view/agent-output-graph.js";

describe("agent-output-graph error routing", () => {
  test("E1 client-only error with no run lands in graph.systemErrors (not runs)", () => {
    const rows = [
      {
        kind: "error",
        at: "2026-05-23T10:00:00.000Z",
        label: "Image too large",
        data: { message: "Image too large", source: "client", scope: "ui", showInOutput: true },
      },
    ];
    const graph: any = buildAgentOutputGraph(rows);
    expect(graph.runs).toHaveLength(0);
    expect(graph.systemErrors).toHaveLength(1);
    expect(graph.systemErrors[0].text).toBe("Image too large");
  });

  test("E2 server error after a user run attaches to that run, not systemErrors", () => {
    const rows = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "error",
        at: "2026-05-23T10:00:01.000Z",
        label: "Model failed",
        data: { message: "Model failed", source: "server", scope: "trace", showInOutput: true },
      },
    ];
    const graph: any = buildAgentOutputGraph(rows);
    expect(graph.runs).toHaveLength(1);
    expect(graph.runs[0].errors).toHaveLength(1);
    expect(graph.systemErrors).toHaveLength(0);
  });

  test("E3 client-source error after a user run still lands in systemErrors (not the run)", () => {
    const rows = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "error",
        at: "2026-05-23T10:00:02.000Z",
        label: "Image too large",
        data: { message: "Image too large", source: "client", scope: "ui", showInOutput: true },
      },
    ];
    const graph: any = buildAgentOutputGraph(rows);
    expect(graph.runs).toHaveLength(1);
    expect(graph.runs[0].errors).toHaveLength(0);
    expect(graph.systemErrors).toHaveLength(1);
  });

  test("E4 legacy error event without source/scope is treated as server (back-compat)", () => {
    const rows = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        kind: "error",
        at: "2026-05-23T10:00:03.000Z",
        label: "Boom",
        data: { message: "Boom", showInOutput: true },
      },
    ];
    const graph: any = buildAgentOutputGraph(rows);
    expect(graph.runs).toHaveLength(1);
    expect(graph.runs[0].errors).toHaveLength(1);
    expect(graph.systemErrors).toHaveLength(0);
  });
});
