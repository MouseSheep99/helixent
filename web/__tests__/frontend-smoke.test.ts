import { describe, expect, test } from "bun:test";

import { buildTraceExport } from "../public/export.js";
import {
  renderCommandsHTML,
  renderMetricsHTML,
  renderMessagesHTML,
  renderOutputHTML,
  renderRequestHTML,
  renderSkillsHTML,
  renderTasksHTML,
  renderTimelineHTML,
  renderToolsHTML,
  replayEventsToState,
} from "../public/view.js";

describe("Trace Lens frontend smoke", () => {
  test("page shell omits the standalone Human-in-loop section", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();

    expect(html).not.toContain("Human-in-loop");
    expect(html).not.toContain('id="humanLoop"');
    expect(html).not.toContain('id="actionCenter"');
    expect(html).not.toContain("Action Center");
    expect(html).toContain('id="modelOutput"');
    expect(html).toContain('id="togglePackage"');
    expect(html).toContain('id="requestPackagePanel"');
    expect(html).toContain('id="agentToolsBar"');
    expect(html).toContain('id="toolDialogExample"');
    expect(html).not.toContain('id="todoPanel"');
    expect(html).not.toContain('id="promptDiffPanel"');
    expect(html).not.toContain("Prompt Assembly");
    expect(html).toContain("Run Metrics");
    expect(html).toContain('id="runMetrics"');
    expect(html).toContain("Hook & Tool Timeline");
    // edge-handle DOM 已注入（R1 R2 R4）
    expect(html).toContain('id="toggleSidebar"');
    expect(html).toContain('id="toggleTimeline"');
    expect(html).toContain('class="edge-handle edge-handle-left"');
    expect(html).toContain('class="edge-handle edge-handle-right"');
    // timeline-rail 存在（R1）
    expect(html).toContain('class="timeline-rail"');
    // topbar 不再有旧的 sidebar-toggle 类（R2）
    expect(html).not.toContain('class="ghost-button icon-button sidebar-toggle"');
    // panel-heading 含 chevron（R5）
    expect(html).toContain('class="panel-chevron"');
    // 新版 topbar 结构：紧凑品牌、inline meta、status-indicator、icon-action-button
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="brand-name"');
    expect(html).not.toContain('class="brand-cluster"');
    expect(html).not.toContain('class="brand-title"');
    expect(html).not.toContain('class="brand-subtitle"');
    expect(html).not.toContain('class="session-summary-card"');
    expect(html).not.toContain('class="path-chip"');
    expect(html).toContain('id="sessionInline"');
    expect(html).toContain('id="workspaceInline"');
    expect(html).toContain('class="status-indicator"');
    expect(html).toContain('class="status-dot"');
    expect(html).toContain('class="icon-action-button"');
    expect(html).toContain('class="icon-gear"');
    // cache busting bumped to 73
    expect(html).toContain("v=trace-lens-workbench-73");
    expect(html).not.toContain("v=trace-lens-workbench-72");
  });

  test("reconstructs request navigation, model output, tools, skills, and timeline from a trace replay", () => {
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/coding-plan build tests" }] } },
      {
        kind: "input_context",
        label: "Input context sent to model",
        at: "2026-05-14T00:00:00.000Z",
        data: {
          prompt: "You are Helixent.",
          messages: [{ role: "user", content: [{ type: "text", text: "build tests" }] }],
          tools: [{ name: "bash", description: "Run shell" }],
          source: "runtime",
          requestedSkillName: "coding-plan",
        },
      },
      {
        kind: "skills_inventory",
        label: "2 skill(s) available",
        at: "2026-05-14T00:00:01.000Z",
        data: { skills: [{ name: "coding-plan" }, { name: "deep-research-plan" }] },
      },
      {
        kind: "skill_system_injected",
        label: "Skill system injected into prompt",
        at: "2026-05-14T00:00:02.000Z",
        data: { requestedSkillName: "coding-plan" },
      },
      { kind: "hook_triggered", label: "beforeModel", at: "2026-05-14T00:00:03.000Z", data: { hook: "beforeModel" } },
      {
        kind: "model_output_block",
        label: "Model output: thinking",
        at: "2026-05-14T00:00:04.000Z",
        data: { block: { type: "thinking", thinking: "I should inspect the repo." } },
      },
      {
        kind: "model_output_block",
        label: "Model output: text",
        at: "2026-05-14T00:00:05.000Z",
        data: { block: { type: "text", text: "I will run the test suite." } },
      },
      {
        kind: "model_output_block",
        label: "Model output: tool_use",
        at: "2026-05-14T00:00:06.000Z",
        data: { block: { type: "tool_use", name: "bash", input: { command: "bun test web" } } },
      },
      {
        kind: "tool_call_detected",
        label: "Runtime detected tool call: bash",
        at: "2026-05-14T00:00:07.000Z",
        data: { toolUse: { type: "tool_use", name: "bash", input: { command: "bun test web" } } },
      },
      {
        kind: "tool_execution_completed",
        label: "Tool completed: bash",
        at: "2026-05-14T00:00:08.000Z",
        data: { resultSummary: "85 pass" },
      },
      { kind: "token_usage", label: "Token usage", at: "2026-05-14T00:00:09.000Z", data: { usage: { input_tokens: 42 } } },
      {
        kind: "agent_progress",
        label: "Tool progress: bash",
        at: "2026-05-14T00:00:10.000Z",
        data: { progress: { type: "progress", subtype: "tool", name: "bash", input: { command: "bun test web" } } },
      },
      {
        kind: "todo_update",
        label: "Todo panel updated",
        at: "2026-05-14T00:00:11.000Z",
        data: { todos: [{ id: "1", content: "Run web tests", status: "completed" }] },
      },
      { type: "message", message: { role: "tool", content: [{ type: "tool_result", content: "85 pass" }] } },
    ];
    const replay = replayEventsToState(rows.map((row) => ("kind" in row ? { ...row, requestId: "req-smoke" } : row)));

    const skills = [
      { slug: "coding-plan", name: "coding-plan", description: "Plan coding changes" },
      { slug: "deep-research-plan", name: "deep-research-plan", description: "Plan research" },
    ];
    const tools = [{ name: "bash", description: "Run shell", requiresApproval: true, enabled: true }];
    const commands = [
      { name: "clear", description: "Clear history", type: "builtin" },
      { name: "coding-plan", description: "Plan coding changes", type: "skill" },
    ];

    const request = renderRequestHTML(replay.events, null, true);
    const output = renderOutputHTML(replay.events, replay.messages);
    const timeline = renderTimelineHTML(replay.events, "all");
    const metrics = renderMetricsHTML(replay.events, { type: "progress", subtype: "tool", name: "bash", input: {} });
    const tasks = renderTasksHTML([], replay.events);

    expect(renderSkillsHTML(skills)).toContain("/coding-plan");
    expect(renderToolsHTML(tools)).toContain("bash");
    expect(renderCommandsHTML(commands)).toContain("/coding-plan");
    expect(renderMessagesHTML(replay.messages)).toContain("/coding-plan build tests");
    expect(request.chips).toContain("/coding-plan");
    expect(request.body).toContain("System prompt");
    expect(request.body).toContain("You are Helixent.");
    expect(request.body).toContain("Replay mode");
    expect(request.diff).toContain("No runtime baseline captured yet.");
    expect(output).toContain("agent-output-graph");
    expect(output).toContain("trail-thinking");
    expect(output).toContain("I will run the test suite.");
    expect(output).toContain("tool-call");
    expect(output).toContain("bash");
    expect(output).not.toContain("Token usage");
    expect(output).toContain("Result");
    expect(metrics).toContain("Input");
    expect(metrics).toContain("Tool · bash");
    expect(tasks).toContain("Run web tests");
    expect(timeline).toContain("timeline-graph");
    expect(timeline).toContain("timeline-tree-line");
    expect(timeline).toContain("Lead agent");
    expect(timeline).toContain("beforeModel");
    expect(timeline).toContain("Tool completed: bash");

    const exported = buildTraceExport(rows, { range: "last-1", session: { sessionId: "s1", model: "deepseek-v4-pro", cwd: "/repo" } });
    expect(exported).toContain("## Prompt Playground Snapshot");
    expect(exported).toContain("## Model Output");
    expect(exported).toContain("Harness Detected Tool Call");
    expect(exported).toContain("## Hook & Tool Timeline");
    expect(exported).toContain("Token usage");
  });

  test("renders live pending human actions in model output without timeline duplication", () => {
    const output = renderOutputHTML(
      [
        { kind: "model_output_block", label: "Model output: text", data: { block: { type: "text", text: "I need permission." } } },
      ],
      {
        pendingApproval: { toolUse: { type: "tool_use", name: "bash", input: { command: "bun run build" } } },
        pendingQuestion: {
          params: {
            questions: [
              {
                header: "Proceed?",
                question: "Pick one",
                options: [
                  { label: "Yes", description: "Continue" },
                  { label: "No", description: "Stop" },
                ],
              },
            ],
          },
        },
      },
    );

    expect(output).toContain("I need permission.");
    expect(output).toContain("Approval requested");
    expect(output).toContain("Question requested");
    expect(output).toContain("Allow once");
    expect(output).toContain("Submit answer");
    expect(output).not.toContain("approval_requested");
    expect(output).not.toContain("question_requested");
  });
});
