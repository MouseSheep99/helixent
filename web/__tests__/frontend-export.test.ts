import { describe, expect, test } from "bun:test";

import { buildRawJsonl, buildTraceExport, buildTraceMarkdown, selectRowsForRange } from "../public/export.js";

const firstRun = { type: "message", message: { role: "user", content: [{ type: "text", text: "first task" }] } };
const secondRun = { type: "message", message: { role: "user", content: [{ type: "text", text: "second task" }] } };
const projectContext = {
  type: "message",
  message: {
    role: "user",
    content: [{ type: "text", text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:" }],
  },
};

describe("frontend trace export helpers", () => {
  test("selects the latest interaction runs without counting bootstrapped project context", () => {
    const rows = [
      projectContext,
      firstRun,
      { kind: "model_output_block", data: { block: { type: "text", text: "first answer" } } },
      secondRun,
      { kind: "model_output_block", data: { block: { type: "text", text: "second answer" } } },
    ];

    expect(selectRowsForRange(rows, "last-1")).toEqual(rows.slice(3));
    expect(selectRowsForRange(rows, "last-2")).toEqual(rows.slice(1));
    expect(selectRowsForRange(rows, "full")).toEqual(rows);
  });

  test("builds markdown with prompt playground snapshot, model output blocks, timeline, tool results, and token usage", () => {
    const markdown = buildTraceMarkdown(
      [
        firstRun,
        {
          kind: "input_context",
          label: "Input context sent to model",
          at: "2026-05-14T00:00:00.000Z",
          data: {
            prompt: [
              '<agent name="Helixent">',
              "Use tools safely.",
              '<skill name="coding-plan" path="/skills/coding-plan/SKILL.md">',
              "Plan coding work.",
              "</skill>",
            ].join("\n"),
            messages: [{ role: "user", content: [{ type: "text", text: "run tests" }] }],
            tools: [{ name: "bash", description: "Run shell" }],
            source: "prompt_version",
            versionId: "version-1",
            versionName: "Edited prompt",
            requestedSkillName: "coding-plan",
          },
        },
        {
          kind: "model_output_block",
          label: "Model output: thinking",
          requestId: "req-1",
          at: "2026-05-14T00:00:01.000Z",
          data: { blockIndex: 0, block: { type: "thinking", thinking: "I should run tests." } },
        },
        {
          kind: "model_output_block",
          label: "Model output: text",
          at: "2026-05-14T00:00:02.000Z",
          data: { block: { type: "text", text: "I will run the web tests." } },
        },
        {
          kind: "tool_call_detected",
          label: "Runtime detected tool call: bash",
          at: "2026-05-14T00:00:03.000Z",
          data: { toolUse: { name: "bash", input: { command: "bun test web" } } },
        },
        {
          kind: "tool_execution_completed",
          label: "Tool completed: bash",
          at: "2026-05-14T00:00:04.000Z",
          data: { resultSummary: "106 pass" },
        },
        {
          kind: "skill_loaded",
          label: "Skill loaded: /coding-plan",
          at: "2026-05-14T00:00:05.000Z",
          data: { skill: { name: "coding-plan" } },
        },
        {
          kind: "token_usage",
          label: "Token usage",
          at: "2026-05-14T00:00:06.000Z",
          data: { usage: { input_tokens: 100, output_tokens: 25 } },
        },
        { type: "message", message: { role: "tool", content: [{ type: "tool_result", content: "106 pass" }] } },
      ],
      { range: "last-1", session: { sessionId: "s1", cwd: "/repo", model: "deepseek" }, generatedAt: "2026-05-14T00:01:00.000Z" },
    );

    expect(markdown).toContain("# Helixent Trace Export");
    expect(markdown).toContain("- Model: deepseek");
    expect(markdown).toContain("## User Query");
    expect(markdown).toContain("run tests");
    expect(markdown).toContain("## Prompt Playground Snapshot");
    expect(markdown).toContain("- Source: prompt_version · Edited prompt");
    expect(markdown).toContain("- System prompt: 5 lines");
    expect(markdown).toContain("- Visible tools: 1 (bash)");
    expect(markdown).toContain("- Forced skill: /coding-plan");
    expect(markdown).toContain("- Prompt version id: version-1");
    expect(markdown).toContain("- Skills in prompt: 1 (coding-plan)");
    expect(markdown).toContain("### System Prompt Preview");
    expect(markdown).toContain("### 1. Thinking");
    expect(markdown).toContain("trace_ref: request=req-1 | kind=model_output_block | block=0");
    expect(markdown).toContain("I should run tests.");
    expect(markdown).toContain("### 2. Response");
    expect(markdown).toContain("Harness Detected Tool Call");
    expect(markdown).toContain("Tool Result");
    expect(markdown).not.toContain("step=1 | kind=tool_call_detected");
    expect(markdown).toContain("kind=tool_execution_completed");
    expect(markdown).toContain("kind=skill_loaded");
    expect(markdown).toContain("input=100 output=25 total=125");
    expect(markdown).not.toContain("Raw Appendix");
  });

  test("omits noisy agent progress rows from markdown timeline", () => {
    const markdown = buildTraceMarkdown([
      firstRun,
      { kind: "agent_progress", label: "Agent thinking", data: { progress: { subtype: "thinking" } } },
      { kind: "hook_triggered", label: "beforeModel", data: { hook: "beforeModel" } },
    ]);

    expect(markdown).toContain("kind=hook_triggered");
    expect(markdown).not.toContain("agent_progress");
    expect(markdown).not.toContain("Agent thinking");
  });

  test("full markdown export includes raw appendix and raw jsonl strips client-only fields", () => {
    const rows = [
      firstRun,
      {
        kind: "model_output_block",
        label: "Model output: text",
        __clientReceivedAt: "2026-05-14T00:00:00.000Z",
        data: { block: { type: "text", text: "answer" } },
      },
    ];

    const full = buildTraceExport(rows, { range: "full", generatedAt: "2026-05-14T00:00:00.000Z" });
    const raw = buildRawJsonl(rows);

    expect(full).toContain("## Raw Appendix");
    expect(raw).toContain('"kind":"model_output_block"');
    expect(raw).not.toContain("__clientReceivedAt");
  });

  test("raw export returns jsonl instead of markdown", () => {
    const raw = buildTraceExport([firstRun, secondRun], { range: "raw" });

    expect(raw).toContain('"first task"');
    expect(raw).toContain('"second task"');
    expect(raw).not.toContain("# Helixent Trace Export");
  });
});
