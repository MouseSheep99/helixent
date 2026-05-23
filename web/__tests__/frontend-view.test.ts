import { describe, expect, test } from "bun:test";

import { MODEL_PROVIDERS } from "@/cli/model-providers";

import {
  buildAgentOutputGraph,
  buildTimelineGraph,
  buildQuestionAnswers,
  compactTimelineEvents,
  contentToText,
  escapeAttr,
  escapeHtml,
  isAgentOutputRow,
  providerBaseURLFor,
  providerTypeFor,
  renderCommandStripHTML,
  renderConfiguredModelsHTML,
  renderCommandsHTML,
  renderDefaultModelOptions,
  renderMessagesHTML,
  renderMetricsHTML,
  renderOutputHTML,
  renderPromptDiffPanelHTML,
  renderProviderOptions,
  renderRequestHTML,
  renderAgentToolsBarHTML,
  renderSentPromptDialogHTML,
  splitAssembledPrompt,
  renderSkillsHTML,
  renderTasksHTML,
  renderTimelineHTML,
  renderToolsHTML,
  renderTracesHTML,
  replayEventsToState,
  shouldShowTimelineEvent,
} from "../public/view.js";

describe("frontend view helpers", () => {
  test("escapes html and attribute content", () => {
    expect(escapeHtml(`<script>"x"&'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#039;&lt;/script&gt;");
    expect(escapeAttr("`quoted`")).toBe("&#096;quoted&#096;");
  });

  test("renders the same model provider catalog as the TUI wizard", () => {
    const html = renderProviderOptions(MODEL_PROVIDERS, "deepseek");

    expect(html).toContain("DeepSeek");
    expect(html).toContain("Qwen");
    expect(html).toContain("Volcengine - Coding Plan");
    expect(html).toContain('value="deepseek"');
    expect(html).toContain("selected");
    expect(providerBaseURLFor("qwen", MODEL_PROVIDERS)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(providerTypeFor("anthropic", MODEL_PROVIDERS)).toBe("anthropic");
  });

  test("renders configured model list and default model options", () => {
    const models = [
      {
        name: "deepseek-v3",
        baseURL: "https://api.deepseek.com/v1",
        provider: "openai",
        hasAPIKey: true,
        APIKeyPreview: "****sk",
      },
      {
        name: "claude-sonnet",
        baseURL: "https://api.anthropic.com",
        provider: "anthropic",
        hasAPIKey: true,
        APIKeyPreview: "****ak",
      },
    ];

    const list = renderConfiguredModelsHTML(models);
    const options = renderDefaultModelOptions(models, "claude-sonnet");

    expect(list).toContain("deepseek-v3");
    expect(list).toContain('data-edit-model="deepseek-v3"');
    expect(list).toContain('data-delete-model="deepseek-v3"');
    expect(list).toContain("https://api.deepseek.com/v1");
    expect(options).toContain('value="claude-sonnet" selected');
  });

  test("renders tools with search, enabled state, approval marker, and schema action", () => {
    const html = renderToolsHTML(
      [
        { name: "bash", description: "Run shell", requiresApproval: true, enabled: false },
        { name: "read_file", description: "Read files", requiresApproval: false, enabled: true },
      ],
      "bash",
    );

    expect(html).toContain("bash");
    expect(html).not.toContain("read_file");
    expect(html).toContain("approval");
    expect(html).toContain('data-tool-schema="bash"');
    expect(html).toContain('data-tool="bash" ');
    expect(html).not.toContain('data-tool="bash" checked');
  });

  test("renders skills and slash command options", () => {
    const skills = [{ slug: "coding-plan", name: "coding-plan", description: "Plan coding changes" }];
    const commands = [{ name: "coding-plan", description: "Plan coding changes", type: "skill" }];

    expect(renderSkillsHTML(skills)).toContain('data-use-skill="coding-plan"');
    expect(renderCommandsHTML(commands)).toContain('value="/coding-plan "');
    expect(renderCommandStripHTML(commands)).toContain('data-command-strip="coding-plan"');
  });

  test("renders trace rows with open and delete actions", () => {
    const html = renderTracesHTML([{ id: "trace-1", size: 273, modifiedTime: "2026-05-14T00:00:00.000Z" }]);

    expect(html).toContain('data-trace="trace-1"');
    expect(html).toContain('data-delete-trace="trace-1"');
    expect(html).toContain("Delete");
  });

  test("renders request navigation chips and input context", () => {
    const rendered = renderRequestHTML(
      [
        {
          kind: "input_context",
          label: "Input context",
          data: {
            prompt: "system prompt",
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            tools: [{ name: "bash", description: "Run shell", parameters: { properties: { command: { type: "string" } } } }],
            source: "runtime",
          },
        },
        { kind: "prompt_version_applied", label: "Prompt version applied", data: { versionId: "version-1", versionName: "v1", source: "prompt_version" } },
        { kind: "tool_call_detected", label: "Detected", data: { toolUse: { name: "bash" } } },
      ],
      {
        activeVersionId: "version-1",
        runtime: {
          source: "runtime" as const,
          prompt: "system prompt",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [{ name: "bash", description: "Run shell" }],
          requestedSkillName: "coding-plan",
        },
        versions: [
          {
            id: "version-1",
            name: "v1",
            source: "prompt_version",
            prompt: "saved prompt",
            messages: [],
            tools: [],
            requestedSkillName: "coding-plan",
            versionId: null,
            createdAt: "2026-05-14T00:00:00.000Z",
            updatedAt: "2026-05-14T00:00:00.000Z",
          },
        ],
      } as any,
      true,
    );

    expect(rendered.chips).toContain("1 tools");
    expect(rendered.chips).toContain("runtime");
    expect(rendered.chips).toContain("v1");
    expect(rendered.chips).toContain("1 tool calls");
    expect(rendered.chips).toContain("replay");
    expect(rendered.body).toContain("System prompt");
    expect(rendered.body).toContain("Replay mode");
    expect(rendered.body).not.toContain("Request Package");
    expect(rendered.diff).toContain("Final request JSON");
  });

  test("renders inline prompt editor for live sessions", () => {
    const rendered = renderRequestHTML(
      [],
      {
        activeVersionId: null,
        runtime: {
          source: "runtime" as const,
          prompt: "You are Helixent.",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [
            { name: "bash", description: "Run shell" },
            { name: "read_file", description: "Read files" },
          ],
          requestedSkillName: "coding-plan",
        },
        versions: [],
      } as any,
      false,
    );

    expect(rendered.body).toContain('data-prompt-editor');
    expect(rendered.body).toContain('data-prompt-system');
    expect(rendered.body).toContain('prompt-editor-hint');
    expect(rendered.body).toContain('data-prompt-sync-status');
    expect(rendered.body).toContain('Latest sync: not yet saved');
    expect(rendered.body).toContain('data-prompt-stats');
    expect(rendered.body).toContain('Save version snapshot');
    expect(rendered.body).not.toContain('data-prompt-messages');
    expect(rendered.body).not.toContain('data-prompt-skill');
    expect(rendered.body).not.toContain('data-prompt-tool-index="0"');
    expect(rendered.body).not.toContain("Save & activate");
    expect(rendered.body).toContain("System prompt ready");
    expect(rendered.body).toContain("System prompt");
    expect(rendered.body).not.toContain("Messages override JSON");
    expect(rendered.body).not.toContain("Tools in this request");
    expect(rendered.body).toContain("Versions");
    expect(rendered.body).not.toContain("+ Skill");
    expect(rendered.body).not.toContain("Package");
    expect(rendered.body).not.toContain("Advanced · messages / tools / raw");
    expect(rendered.body).not.toContain("View raw system prompt");
    expect(rendered.body).not.toContain("Diff / Assembly");
    expect(rendered.body).not.toContain("final prompt · versions · diff");
    expect(rendered.package).toContain('data-prompt-messages');
    expect(rendered.package).not.toContain('data-prompt-tools-bar');
    expect(rendered.package).toContain("Messages override JSON");
    expect(rendered.package).not.toContain("Tools available");
    expect(rendered.package).toContain("System prompt");
    expect(rendered.package).toContain("You are Helixent.");
    expect(rendered.package).not.toContain('data-prompt-tool-index="0"');
    expect(rendered.package).not.toContain("Tools in this request");
  });

  test("renders editable prompt playground before the first model request", () => {
    const rendered = renderRequestHTML(
      [],
      { activeVersionId: null, runtime: null, versions: [] } as any,
      false,
      {
        source: "runtime",
        prompt: "",
        messages: [],
        tools: [{ name: "bash", description: "Run shell" }],
        requestedSkillName: null,
      } as any,
    );

    expect(rendered.body).toContain("System prompt");
    expect(rendered.body).toContain('data-prompt-editor');
    expect(rendered.body).toContain('data-prompt-system');
    expect(rendered.body).not.toContain('data-prompt-tool-index="0"');
    expect(rendered.package).not.toContain('data-prompt-tools-bar');
    expect(rendered.package).not.toContain("Tools available");
    expect(rendered.body).not.toContain("No model request captured yet.");
    expect(rendered.metrics).toContainEqual({ label: "Prompt diff", value: "baseline missing" });
    expect(rendered.metrics).toContainEqual({ label: "Messages", value: "0" });
    expect(rendered.metrics).toContainEqual({ label: "Tool diff", value: "n/a" });
    expect(rendered.metrics).toContainEqual({ label: "Skill diff", value: "n/a" });
    expect(rendered.metrics).toContainEqual({ label: "Prompt source", value: "Runtime" });
    expect(rendered.metrics).toContainEqual({ label: "Mode", value: "Live" });
  });

  test("draftPrompt overrides the displayed system prompt and shows draft status pill", () => {
    const rendered = renderRequestHTML(
      [],
      {
        activeVersionId: null,
        runtime: null,
        versions: [],
        draftPrompt: "DRAFT-CONTENT-XYZ",
        draftUpdatedAt: "2026-05-19T06:01:20.334Z",
      } as any,
      false,
      {
        source: "runtime",
        prompt: "RUNTIME-CONTENT",
        messages: [],
        tools: [],
        requestedSkillName: null,
      } as any,
    );
    expect(rendered.body).toContain("DRAFT-CONTENT-XYZ");
    expect(rendered.body).not.toContain("<textarea data-prompt-system rows=\"20\" spellcheck=\"false\">RUNTIME-CONTENT</textarea>");
    expect(rendered.body).toContain('data-tone="draft"');
    expect(rendered.body).toContain("Auto-saved draft");
    expect(rendered.body).toContain("Latest sync:");
    expect(rendered.body).not.toContain("not yet saved");
    expect(rendered.body).toContain("Discard draft");
  });

  test("renders structured Diff / Assembly between active version and runtime", () => {
    const runtime = {
      source: "runtime" as const,
      prompt: "system prompt line 1\nshared\nline 3",
      messages: [{ role: "user", content: [{ type: "text", text: "runtime query" }] }],
      tools: [
        { name: "bash", description: "Run shell" },
        { name: "read_file", description: "Read files" },
      ],
      requestedSkillName: null,
    };
    const versions = [
      {
        id: "version-x",
        name: "Edited",
        source: "prompt_version" as const,
        prompt: "system prompt line 1\nshared\nbrand new line",
        messages: [{ role: "user", content: [{ type: "text", text: "edited query" }] }],
        tools: [{ name: "bash", description: "Run shell" }],
        requestedSkillName: "coding-plan",
        versionId: null,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    ];
    const rendered = renderRequestHTML(
      [],
      {
        activeVersionId: "version-x",
        runtime,
        versions,
      } as any,
      false,
    );

    expect(rendered.body).not.toContain("Diff / Assembly");
    expect(rendered.diff).toContain("Edited vs runtime");
    expect(rendered.diff).toContain("View detailed diff");
    expect(rendered.diff).toContain("brand new line");
    expect(rendered.diff).toContain("last user query changed");
    expect(rendered.diff).toContain("edited query");
    expect(rendered.diff).toContain("runtime query");
    // tool diff: read_file removed when active version drops it
    expect(rendered.diff).toContain("read_file");
    expect(rendered.diff).toContain("0 added · 1 removed");
    expect(rendered.diff).toContain("Final request JSON");
    expect(rendered.diff).toContain("&quot;prompt&quot;");
    expect(rendered.diff).toContain("&quot;messages&quot;");
    expect(rendered.diff).toContain("&quot;tools&quot;");
  });

  test("renders compact prompt diff summary for the right sidebar", () => {
    const html = renderPromptDiffPanelHTML({
      current: {
        prompt: "new prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "new" }] }],
        tools: [{ name: "bash" }],
        requestedSkillName: "coding-plan",
      },
      runtime: {
        prompt: "old prompt",
        messages: [],
        tools: [{ name: "bash" }, { name: "read_file" }],
        requestedSkillName: null,
      },
      activeVersion: { name: "Edited" },
      promptSource: "prompt_version",
    } as any);

    expect(html).toContain("Edited vs runtime");
    expect(html).toContain("System");
    expect(html).toContain("changed");
    expect(html).toContain("Messages");
    expect(html).toContain("0 → 1");
    expect(html).toContain("Tools");
    expect(html).toContain("+0 / -1");
    expect(html).toContain("View detailed diff");
    expect(html).toContain("Final request JSON");
    expect(html).toContain("&quot;requestedSkillName&quot;");
  });

  test("builds an agent output graph from ReAct rows", () => {
    const graph: any = buildAgentOutputGraph([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "check skills" }] } },
      { kind: "input_context", data: { prompt: "system" } },
      { kind: "model_output_block", data: { blockIndex: 0, block: { type: "thinking", thinking: "inspect first" } } },
      { kind: "model_output_block", data: { blockIndex: 1, block: { type: "tool_use", id: "call_1", name: "read_file", input: { path: "SKILL.md" } } } },
      { kind: "tool_call_detected", data: { blockIndex: 1, toolUse: { id: "call_1", name: "read_file", input: { path: "SKILL.md" } } } },
      { type: "message", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] } },
      { kind: "model_output_block", data: { blockIndex: 0, block: { type: "text", text: "done" } } },
      { kind: "token_usage", data: { usage: { input_tokens: 1 } } },
      { kind: "hook_triggered", label: "beforeModel" },
    ]);

    expect(graph.runs).toHaveLength(1);
    expect(graph.runs[0].sentPromptRowIndex).toBe(1);
    expect(graph.runs[0].status).toBe("success");
    expect(graph.runs[0].steps).toHaveLength(2);
    expect(graph.runs[0].steps[0].thinking).toHaveLength(1);
    expect(graph.runs[0].steps[0].tools).toHaveLength(1);
    expect(graph.runs[0].steps[0].tools[0].name).toBe("read_file");
    expect(graph.runs[0].steps[0].tools[0].status).toBe("success");
    expect(graph.runs[0].steps[0].tools[0].detected?.type).toBe("tool_detected");
    expect(graph.runs[0].steps[1].response).toHaveLength(1);
    expect(graph.nodeById["tool:call_1"]).toBe(graph.runs[0].steps[0].tools[0]);
  });

  test("builds graph status for orphan and errored tool results", () => {
    const graph: any = buildAgentOutputGraph([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "run tool" }] } },
      { type: "message", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "missing", content: "Error: failed" }] } },
    ]);

    expect(graph.runs).toHaveLength(1);
    expect(graph.runs[0].status).toBe("error");
    expect(graph.runs[0].steps[0].tools[0].name).toBe("unknown_tool");
    expect(graph.runs[0].steps[0].tools[0].status).toBe("error");
  });

  test("filters only rows relevant to Agent Output", () => {
    expect(isAgentOutputRow({ kind: "model_output_block" })).toBe(true);
    expect(isAgentOutputRow({ kind: "input_context" })).toBe(true);
    expect(isAgentOutputRow({ kind: "error", data: { showInOutput: false } })).toBe(false);
    expect(isAgentOutputRow({ kind: "token_usage" })).toBe(false);
    expect(isAgentOutputRow({ kind: "hook_triggered" })).toBe(false);
  });

  test("renders user message, project context, and tool result inside Model Output", () => {
    const html = renderOutputHTML([
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n# Helixent" },
          ],
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "/coding-plan build tests" }] },
      },
      { kind: "model_output_block", data: { block: { type: "text", text: "I will run tests." } } },
      { kind: "tool_call_detected", data: { toolUse: { name: "bash", input: { command: "bun test" } } } },
      { type: "message", message: { role: "tool", content: [{ type: "tool_result", content: "85 pass" }] } },
    ]);

    expect(html).toContain("Project context");
    expect(html).toContain("/coding-plan build tests");
    expect(html).toContain("agent-output-graph");
    expect(html).toContain("final-answer-text");
    expect(html).toContain("unknown_tool");
    expect(html).toContain("Result");
    expect(html).toContain('data-message-index="0"'); // project context message
    expect(html).toContain('data-message-index="1"'); // user message
    expect(html).toContain('data-message-index="2"'); // tool result message
  });

  test("renders pending approval and question cards after existing model output", () => {
    const html = renderOutputHTML(
      [
        { kind: "model_output_block", data: { block: { type: "text", text: "Need user confirmation." } } },
      ],
      {
        pendingApproval: {
          toolUse: { name: "bash", input: { command: "rm -rf tmp" } },
        },
        pendingQuestion: {
          params: {
            questions: [
              {
                header: "Deployment target",
                question: "Choose environment",
                options: [
                  { label: "Staging", description: "Safe pre-prod environment" },
                  { label: "Production", description: "Live environment" },
                ],
              },
            ],
          },
        },
      },
    );

    expect(html.indexOf("Need user confirmation.")).toBeLessThan(html.indexOf("Approval requested"));
    expect(html).toContain("output-card human_action approval");
    expect(html).toContain("Approval requested");
    expect(html).toContain("bash");
    expect(html).toContain("Allow once");
    expect(html).toContain("Always allow");
    expect(html).toContain("Deny");
    expect(html).toContain("output-card human_action question");
    expect(html).toContain("Question requested");
    expect(html).toContain("Deployment target");
    expect(html).toContain('name="question-0"');
    expect(html).toContain("Staging");
    expect(html).toContain("checked");
    expect(html).toContain("data-submit-question");
  });

  test("renders model output empty state without implying a separate human panel", () => {
    expect(renderOutputHTML([])).toContain("No model output or pending human action yet.");
  });

  test("renders streaming thinking placeholder card when streaming with no rows yet", () => {
    const html = renderOutputHTML([], { streaming: true, progress: null });
    expect(html).toContain("thinking-placeholder");
    expect(html).toContain("Thinking…");
    expect(html).toContain("Waiting for model response");
    expect(html).not.toContain("No model output or pending human action yet.");
  });

  test("streaming placeholder shows tool subtype label when progress is a tool", () => {
    const html = renderOutputHTML([], {
      streaming: true,
      progress: { subtype: "tool", name: "read_file" },
    });
    expect(html).toContain("Tool · read_file");
  });

  test("renders assistant message blocks (thinking / text / tool_use) as separate styled cards", () => {
    const html = renderOutputHTML([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason about the request first." },
            { type: "text", text: "Here is what I will do." },
            { type: "tool_use", name: "ask_user_question", input: { questions: [] } },
          ],
        },
      },
    ]);

    expect(html).toContain("trail-thinking");
    expect(html).toContain("Let me reason about the request first.");
    expect(html).toContain("final-answer-text");
    expect(html).toContain("Here is what I will do.");
    expect(html).toContain("tool-call");
    expect(html).toContain("ask_user_question");
    // assistant blocks should NOT collapse into one Response card with raw "[thinking]" / "[tool_use ...]" strings
    expect(html).not.toContain("[thinking]");
    expect(html).not.toContain("[tool_use ask_user_question]");
  });

  test("skips assistant message cards when model output blocks already render them", () => {
    const html = renderOutputHTML([
      { kind: "model_output_block", data: { block: { type: "thinking", thinking: "Reason once." } } },
      { kind: "model_output_block", data: { block: { type: "text", text: "Answer once." } } },
      {
        type: "message",
        message: {
          role: "assistant",
          __skipModelOutput: true,
          content: [
            { type: "thinking", thinking: "Reason once." },
            { type: "text", text: "Answer once." },
          ],
        },
      },
    ]);

    expect((html.match(/<div class="trail-thinking-text">Reason once\.<\/div>/g) || []).length).toBe(1);
    expect((html.match(/<div class="final-answer-text">Answer once\.<\/div>/g) || []).length).toBe(1);
  });

  test("renders model output block variants and tool results", () => {
    const html = renderOutputHTML(
      [
        { kind: "model_output_block", data: { block: { type: "thinking", thinking: "reasoning" } } },
        { kind: "model_output_block", data: { block: { type: "text", text: "answer" } } },
        { kind: "model_output_block", data: { block: { type: "tool_use", name: "bash", input: { command: "pwd" } } } },
        { kind: "tool_call_detected", data: { toolUse: { name: "bash", input: { command: "pwd" } } } },
        { kind: "token_usage", data: { usage: { input_tokens: 1, output_tokens: 2 } } },
        { kind: "error", label: "401 The API key format is incorrect.", data: { showInOutput: true } },
        { kind: "error", label: "SSE connection interrupted.", data: { showInOutput: false } },
      ],
      [{ role: "tool", content: [{ type: "tool_result", content: "ok" }] }],
    );

    expect(html).toContain("trail-thinking");
    expect(html).toContain("final-answer-text");
    expect(html).toContain("bash");
    expect(html).toContain("tool-call");
    expect(html).not.toContain("Token usage");
    expect(html).toContain("Result");
    expect(html).toContain("Runtime error");
    expect(html).toContain("API key format is incorrect");
    expect(html).not.toContain("SSE connection interrupted");
  });

  test("renders token usage in run metrics instead of model output", () => {
    const events = [
      { kind: "token_usage", data: { usage: { input_tokens: 1234, output_tokens: 56 } } },
      { kind: "tool_call_detected", data: { toolUse: { name: "bash" } } },
      { kind: "hook_triggered", label: "beforeModel" },
    ];

    const metrics = renderMetricsHTML(events, { type: "progress", subtype: "tool", name: "bash", input: {} });

    expect(metrics).toContain("Tool · bash");
    expect(metrics).toContain("1.2k");
    expect(metrics).toContain("56");
    expect(metrics).toContain("Tool calls");
  });

  test("renders prompt diff and global stats inside run metrics", () => {
    const metrics = renderMetricsHTML([], null, [
      { label: "Prompt diff", value: "changed" },
      { label: "Messages", value: "0 -> 1" },
      { label: "Tool diff", value: "+0 / -1" },
      { label: "Skill diff", value: "unchanged" },
      { label: "Prompt source", value: "Runtime" },
      { label: "Mode", value: "Live" },
    ]);

    expect(metrics).toContain("Prompt diff");
    expect(metrics).toContain("changed");
    expect(metrics).toContain("Messages");
    expect(metrics).toContain("0 -&gt; 1");
    expect(metrics).toContain("Tool diff");
    expect(metrics).toContain("+0 / -1");
    expect(metrics).toContain("Skill diff");
    expect(metrics).toContain("unchanged");
    expect(metrics).toContain("Prompt source");
    expect(metrics).toContain("Runtime");
    expect(metrics).toContain("Mode");
    expect(metrics).toContain("Live");
  });

  test("renders tasks from todo trace events", () => {
    const html = renderTasksHTML([], [
      {
        kind: "todo_update",
        data: {
          todos: [
            { id: "1", content: "Inspect TUI", status: "completed" },
            { id: "2", content: "Redesign layout", status: "in_progress" },
          ],
        },
      },
    ]);

    expect(html).toContain("1 completed");
    expect(html).toContain("1 in progress");
    expect(html).toContain("Inspect TUI");
    expect(html).toContain("◐");
  });

  test("filters timeline categories", () => {
    const hook = { kind: "hook_triggered", label: "beforeModel", at: "2026-05-14T00:00:00.000Z" };
    const model = { kind: "input_context", label: "Input context", at: "2026-05-14T00:00:00.000Z" };
    const tool = { kind: "tool_execution_completed", label: "Tool completed", at: "2026-05-14T00:00:00.000Z" };
    const skill = { kind: "skill_loaded", label: "Skill loaded: /coding-plan", at: "2026-05-14T00:00:00.000Z" };
    const human = { kind: "approval_requested", label: "Approval", at: "2026-05-14T00:00:00.000Z" };
    const todo = { kind: "todo_update", label: "Todo panel updated", at: "2026-05-14T00:00:00.000Z" };

    expect(shouldShowTimelineEvent(hook, "hooks")).toBe(true);
    expect(shouldShowTimelineEvent(model, "all")).toBe(false);
    expect(shouldShowTimelineEvent(model, "model")).toBe(true);
    expect(shouldShowTimelineEvent(tool, "tools")).toBe(true);
    expect(shouldShowTimelineEvent(skill, "tools")).toBe(true);
    expect(shouldShowTimelineEvent(human, "human")).toBe(true);
    expect(shouldShowTimelineEvent(todo, "session")).toBe(true);
    expect(renderTimelineHTML([hook, tool, skill], "tools")).toContain("Tool completed");
    expect(renderTimelineHTML([hook, tool, skill], "tools")).toContain("Skill loaded");
    expect(renderTimelineHTML([hook, tool], "tools")).not.toContain("beforeModel");
  });

  test("builds timeline graph with run, lead agent, react step, and phases", () => {
    const events = [
      { id: "run-start", requestId: "req-1", kind: "hook_triggered", label: "beforeAgentRun", at: "2026-05-14T00:00:00.000Z", data: { hook: "beforeAgentRun" } },
      { id: "step-start", requestId: "req-1", kind: "hook_triggered", label: "beforeAgentStep", at: "2026-05-14T00:00:01.000Z", data: { hook: "beforeAgentStep", step: 1 } },
      { id: "input", requestId: "req-1", kind: "input_context", label: "Input context", at: "2026-05-14T00:00:02.000Z", data: { prompt: "system" } },
      { id: "skills", requestId: "req-1", kind: "skills_inventory", label: "Skills available", at: "2026-05-14T00:00:03.000Z", data: { skills: [] } },
      { id: "model", requestId: "req-1", kind: "hook_triggered", label: "beforeModel", at: "2026-05-14T00:00:04.000Z", data: { hook: "beforeModel" } },
      { id: "tool-plan", requestId: "req-1", kind: "tool_call_detected", label: "Runtime detected tool call: bash", at: "2026-05-14T00:00:05.000Z", data: { toolUse: { name: "bash" } } },
      { id: "tool-done", requestId: "req-1", kind: "tool_execution_completed", label: "Tool completed: bash", at: "2026-05-14T00:00:06.000Z", data: { toolName: "bash" } },
      { id: "approval", requestId: "req-1", kind: "approval_requested", label: "Approval requested", at: "2026-05-14T00:00:07.000Z", data: {} },
      { id: "todo", requestId: "req-1", kind: "todo_update", label: "Todo panel updated", at: "2026-05-14T00:00:08.000Z", data: { todos: [] } },
      { id: "global", kind: "tool_enabled_updated", label: "Tool enabled updated", at: "2026-05-14T00:00:09.000Z", data: {} },
    ];

    const graph: any = buildTimelineGraph(events);
    const session = graph.roots.find((node: any) => node.type === "session");
    const run = graph.roots.find((node: any) => node.type === "run");
    const agent = run?.children.find((node: any) => node.type === "agent_execution");
    const step = agent?.children.find((node: any) => node.type === "react_step");
    const phaseTypes = step?.children.map((node: any) => node.type);

    expect(session?.title).toBe("Workspace / Session Events");
    expect(run?.title).toBe("Run 1");
    expect(agent?.agentId).toBe("lead");
    expect(step?.step).toBe(1);
    expect(phaseTypes).toEqual(["prompt_phase", "skills", "model_call", "tool_planning", "tool_execution", "human_gate", "todo", "unscoped"]);

    const html = renderTimelineHTML(events, "all");
    expect(html).toContain("timeline-graph");
    expect(html).toContain("timeline-tree-line");
    expect(html).toContain("Lead agent");
    expect(html).toContain("Step 1");
    expect(html).toContain("Tool Planning");
  });

  test("compacts repeated agent progress events in the timeline UI", () => {
    const events = [
      {
        kind: "agent_progress",
        label: "Agent thinking",
        at: "2026-05-14T08:47:43.000Z",
        data: { progress: { type: "progress", subtype: "thinking" } },
      },
      {
        kind: "agent_progress",
        label: "Agent thinking",
        at: "2026-05-14T08:47:44.000Z",
        data: { progress: { type: "progress", subtype: "thinking" } },
      },
      {
        kind: "agent_progress",
        label: "Tool progress: bash",
        at: "2026-05-14T08:47:45.000Z",
        data: { progress: { type: "progress", subtype: "tool", name: "bash" } },
      },
    ];

    const compacted = compactTimelineEvents(events);
    const html = renderTimelineHTML(events, "all");

    expect(compacted).toHaveLength(2);
    expect(compacted[0].count).toBe(2);
    expect(html).toContain("x2");
  });

  test("replays mixed trace jsonl rows into messages and trace events", () => {
    const replay = replayEventsToState([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { kind: "hook_triggered", label: "beforeModel" },
      { kind: "agent_progress", label: "Agent thinking", data: { progress: { type: "progress", subtype: "thinking" } } },
    ]);

    expect(replay.messages).toHaveLength(1);
    expect(replay.events).toHaveLength(2);
  });

  test("builds fallback answers for unanswered questions", () => {
    const answers = buildQuestionAnswers(
      [
        {
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
      [[]],
    );

    expect(answers).toEqual([{ question_index: 0, selected_labels: ["A"] }]);
  });

  test("formats message content blocks for message cards", () => {
    expect(contentToText({ type: "tool_use", name: "bash", input: { command: "pwd" } })).toContain("[tool_use bash]");
    expect(contentToText({ type: "image_url", image_url: { url: "https://example.test/image.png" } })).toContain("[image]");
  });

  test("labels bootstrapped AGENTS.md messages as project context", () => {
    const html = renderMessagesHTML([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n\n# Helixent",
          },
        ],
      },
    ]);

    expect(html).toContain("Project Context · AGENTS.md");
    expect(html).toContain("project-context");
    expect(html).toContain('data-message-index="0"');
    expect(html).toContain("message-preview");
    expect(html).toContain("Inspect");
  });

  test("renders agent tools bar with enable/disable affordances for live tools", () => {
    const html = renderAgentToolsBarHTML([
      { name: "bash", description: "Run shell", enabled: true },
      { name: "read_file", description: "Read files", enabled: true },
      { name: "apply_patch", description: "Patch", enabled: false },
    ]);

    expect(html).toContain("Tools available · 2");
    expect(html).toContain('data-agent-tool-disable="bash"');
    expect(html).toContain('data-agent-tool-disable="read_file"');
    expect(html).toContain("Disabled · 1");
    expect(html).toContain('data-agent-tool-enable="apply_patch"');
    expect(html).toContain("agent-tool-chip enabled");
    expect(html).toContain("agent-tool-chip disabled");
  });

  test("renders agent tools bar empty state when no tools registered", () => {
    expect(renderAgentToolsBarHTML([])).toContain("Tools available · 0");
    expect(renderAgentToolsBarHTML([])).toContain("No tools registered.");
  });

  test("splitAssembledPrompt separates base from middleware additions", () => {
    const base = "<agent>You are Helixent.</agent>";
    const added = "\n<skill_system>\n<skills>\n<skill name=\"x\" />\n</skills>\n</skill_system>";
    const split = splitAssembledPrompt(base + added, base);
    expect(split.baseText).toBe(base);
    expect(split.addedText).toBe(added);

    const fallback = splitAssembledPrompt(base + added, "totally different base");
    expect(fallback.addedText).toContain("<skill_system>");
    expect(fallback.baseText).toContain("<agent>");

    const noSkills = splitAssembledPrompt(base, base);
    expect(noSkills.addedText).toBe("");
  });

  test("renderSentPromptDialogHTML highlights base vs middleware additions", () => {
    const base = "<agent>You are Helixent.</agent>";
    const added = "\n<skill_system>\n<skills>\n<skill name=\"x\" />\n</skills>\n</skill_system>";
    const html = renderSentPromptDialogHTML({
      assembled: base + added,
      basePrompt: base,
      versionName: null,
      source: "runtime",
      at: "2026-05-14T00:00:00.000Z",
    });
    expect(html).toContain("System prompt sent to model");
    expect(html).toContain("sent-prompt-segment base");
    expect(html).toContain("sent-prompt-segment added");
    expect(html).toContain("&lt;agent&gt;");
    expect(html).toContain("&lt;skill_system&gt;");
    expect(html).toContain("Editable base (Prompt Lab)");
    expect(html).toContain("Injected per-turn by middleware");
  });

  test("renderSentPromptDialogHTML notes when middleware adds nothing", () => {
    const html = renderSentPromptDialogHTML({
      assembled: "<agent>only base</agent>",
      basePrompt: "<agent>only base</agent>",
    });
    expect(html).toContain("No middleware additions on this turn.");
    expect(html).not.toContain("sent-prompt-segment added");
  });

  test("renderOutputHTML attaches the sent-prompt button to assistant blocks following an input_context", () => {
    const html = renderOutputHTML([
      {
        kind: "input_context",
        label: "Input context",
        at: "2026-05-14T00:00:00.000Z",
        data: { prompt: "<agent>base</agent>\n<skill_system></skill_system>" },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
    ]);
    expect(html).toContain("data-sent-prompt-row=\"0\"");
    expect(html).toContain("View system prompt sent to model");
  });

  test("renderOutputHTML omits the sent-prompt button when no input_context preceded the block", () => {
    const html = renderOutputHTML([
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    expect(html).not.toContain("data-sent-prompt-row");
  });
});
