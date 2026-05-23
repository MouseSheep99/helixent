import { describe, expect, test } from "bun:test";

import {
  buildTimelineExport,
  timelineExportFileName,
} from "../public/timeline-export-builder.js";
import { buildRawJsonl } from "../public/export.js";

const userRun = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

function event(kind: string, opts: Record<string, unknown> = {}) {
  return {
    kind,
    requestId: opts.requestId ?? "req-1",
    at: opts.at ?? "2026-05-23T10:00:00Z",
    label: opts.label ?? kind,
    data: opts.data ?? {},
    graph: opts.graph,
  };
}

const sampleRows = [
  userRun("hello"),
  event("hook_triggered", {
    requestId: "req-1",
    at: "2026-05-23T10:00:00.100Z",
    label: "beforeAgentRun",
    data: { hook: "beforeAgentRun" },
  }),
  event("hook_triggered", {
    requestId: "req-1",
    at: "2026-05-23T10:00:00.200Z",
    label: "beforeAgentStep",
    data: { hook: "beforeAgentStep", step: 1 },
    graph: { step: 1 },
  }),
  event("hook_triggered", {
    requestId: "req-1",
    at: "2026-05-23T10:00:01Z",
    label: "beforeModel",
    data: { hook: "beforeModel" },
    graph: { step: 1 },
  }),
  event("tool_call_detected", {
    requestId: "req-1",
    at: "2026-05-23T10:00:02Z",
    label: "Runtime detected tool call: bash",
    data: { toolUse: { name: "bash", id: "tu-1" } },
    graph: { step: 1 },
  }),
  event("tool_execution_started", {
    requestId: "req-1",
    at: "2026-05-23T10:00:03Z",
    label: "Tool started: bash",
    data: { toolName: "bash" },
    graph: { step: 1 },
  }),
  event("tool_execution_completed", {
    requestId: "req-1",
    at: "2026-05-23T10:00:04Z",
    label: "Tool completed: bash",
    data: { toolName: "bash" },
    graph: { step: 1 },
  }),
  event("hook_triggered", {
    requestId: "req-1",
    at: "2026-05-23T10:00:05Z",
    label: "afterAgentStep",
    data: { hook: "afterAgentStep", step: 1 },
    graph: { step: 1 },
  }),
  event("hook_triggered", {
    requestId: "req-1",
    at: "2026-05-23T10:00:06Z",
    label: "afterAgentRun",
    data: { hook: "afterAgentRun" },
  }),
];

const secondRunRows = [
  userRun("second"),
  event("hook_triggered", {
    requestId: "req-2",
    at: "2026-05-23T11:00:00.100Z",
    label: "beforeAgentRun",
    data: { hook: "beforeAgentRun" },
  }),
  event("hook_triggered", {
    requestId: "req-2",
    at: "2026-05-23T11:00:00.200Z",
    label: "beforeAgentStep",
    data: { hook: "beforeAgentStep", step: 1 },
    graph: { step: 1 },
  }),
  event("tool_call_detected", {
    requestId: "req-2",
    at: "2026-05-23T11:00:01Z",
    label: "Runtime detected tool call: bash",
    data: { toolUse: { name: "bash", id: "tu-2" } },
    graph: { step: 1 },
  }),
];

describe("timeline export builder", () => {
  test("T1: markdown format renders Run/Lead agent/Step/[phase] tree", () => {
    const md = buildTimelineExport(sampleRows, {
      range: "last-1",
      format: "markdown",
      filter: "all",
      generatedAt: "2026-05-23T10:00:10Z",
    });

    expect(md).toContain("# Helixent Timeline Export");
    expect(md).toContain("- Range: Last 1 run");
    expect(md).toContain("- Generated: 2026-05-23T10:00:10Z");
    expect(md).toContain("## Run 1");
    expect(md).toContain("Lead agent");
    expect(md).toContain("Step 1");
    expect(md).toContain("[model_call]");
    expect(md).toContain("[tool_planning]");
    expect(md).toContain("[tool_execution]");

    // phase order: model_call appears before tool_planning before tool_execution
    const idxModel = md.indexOf("[model_call]");
    const idxPlanning = md.indexOf("[tool_planning]");
    const idxExec = md.indexOf("[tool_execution]");
    expect(idxModel).toBeLessThan(idxPlanning);
    expect(idxPlanning).toBeLessThan(idxExec);
  });

  test("T2: csv format has correct header and escapes \", , and newline", () => {
    const rows = [
      event("user_message", {
        requestId: "req-csv",
        at: "2026-05-23T10:00:00Z",
        label: "User message",
        data: { content: [{ type: "text", text: 'hello, "world"\nnewline' }] },
      }),
    ];
    const csv = buildTimelineExport(rows, {
      range: "full",
      format: "csv",
      filter: "all",
    });

    const lines = csv.split("\n");
    expect(lines[0]).toBe("at,kind,category,agentId,step,phase,label,detail");
    // Detail column should be quoted and escape both `,` `"` and `\n`.
    expect(csv).toContain('"hello, ""world""');
    expect(csv).toContain("user_message");
    expect(csv).toContain("user_input");
  });

  test("T3: jsonl format equals buildRawJsonl(visible)", () => {
    const jsonl = buildTimelineExport(sampleRows, {
      range: "full",
      format: "jsonl",
      filter: "all",
    });
    const filtered = (sampleRows as Array<Record<string, unknown>>)
      .filter((r) => typeof r.kind === "string")
      .filter((e) => e.kind !== "input_context" && e.kind !== "model_output_block");
    expect(jsonl).toBe(buildRawJsonl(filtered));
  });

  test("T4: range=last-1 keeps only the latest run", () => {
    const md = buildTimelineExport([...sampleRows, ...secondRunRows], {
      range: "last-1",
      format: "markdown",
      filter: "all",
    });
    expect(md).toContain("(req-2)");
    expect(md).not.toContain("(req-1)");
    // last run is req-2 starting at 11:00; events from req-1 (10:00) must not appear.
    expect(md).not.toContain("2026-05-23T10:00");
  });

  test("T5: filter=tools drops hook/model events", () => {
    const csv = buildTimelineExport(sampleRows, {
      range: "full",
      format: "csv",
      filter: "tools",
    });
    expect(csv).toContain("tool_call_detected");
    expect(csv).toContain("tool_execution_started");
    expect(csv).toContain("tool_execution_completed");
    expect(csv).not.toContain("hook_triggered");
    expect(csv).not.toContain("user_message");
  });

  test("T6: filename rule includes traceId+range with ext switching md/csv/jsonl", () => {
    expect(timelineExportFileName("markdown", { traceId: "abc-1", range: "last-3" })).toBe(
      "helixent-timeline-abc-1-last-3.md",
    );
    expect(timelineExportFileName("csv", { traceId: "abc-1", range: "last-3" })).toBe(
      "helixent-timeline-abc-1-last-3.csv",
    );
    expect(timelineExportFileName("jsonl", { traceId: "abc-1", range: "last-3" })).toBe(
      "helixent-timeline-abc-1-last-3.jsonl",
    );
    expect(timelineExportFileName("markdown", {})).toBe("helixent-timeline-trace-last-1.md");
  });
});
