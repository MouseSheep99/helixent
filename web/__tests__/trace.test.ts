import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { appendTraceLine, buildTracePath, createTraceEvent, createTraceMiddleware, deleteTraceFile, listTraceFiles, readTraceFile } from "../trace";

let tempDir: string | undefined;

async function tempTraceDir() {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-web-trace-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("trace files", () => {
  test("writes and reads jsonl trace events", async () => {
    const traceDir = await tempTraceDir();
    const path = buildTracePath(traceDir, "session-1");
    const event = createTraceEvent({
      sessionId: "session-1",
      requestId: "request-1",
      kind: "tool_call_detected",
      label: "Runtime detected tool call: bash",
      data: { toolName: "bash" },
    });

    await appendTraceLine(path, event);

    const files = await listTraceFiles(traceDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toContain("session-1");

    const replay = await readTraceFile(traceDir, files[0]!.id);
    expect(replay).toEqual([event]);
  });

  test("supports persisted todo and agent progress trace events", async () => {
    const traceDir = await tempTraceDir();
    const path = buildTracePath(traceDir, "session-progress");
    const todoEvent = createTraceEvent({
      sessionId: "session-progress",
      requestId: "request-1",
      kind: "todo_update",
      label: "Todo panel updated",
      data: { todos: [{ id: "1", content: "Write tests", status: "in_progress" }] },
    });
    const progressEvent = createTraceEvent({
      sessionId: "session-progress",
      requestId: "request-1",
      kind: "agent_progress",
      label: "Tool progress: bash",
      data: { progress: { type: "progress", subtype: "tool", name: "bash", input: { command: "bun test" } } },
    });

    await appendTraceLine(path, todoEvent);
    await appendTraceLine(path, progressEvent);

    const files = await listTraceFiles(traceDir);
    const replay = await readTraceFile(traceDir, files[0]!.id);
    expect(replay).toEqual([todoEvent, progressEvent]);
  });

  test("supports persisted skill loaded trace events", async () => {
    const traceDir = await tempTraceDir();
    const path = buildTracePath(traceDir, "session-skill");
    const skillEvent = createTraceEvent({
      sessionId: "session-skill",
      requestId: "request-1",
      kind: "skill_loaded",
      label: "Skill loaded: /coding-plan",
      data: { skill: { name: "coding-plan", path: "/tmp/skills/coding-plan/SKILL.md" } },
    });

    await appendTraceLine(path, skillEvent);

    const files = await listTraceFiles(traceDir);
    const replay = await readTraceFile(traceDir, files[0]!.id);
    expect(replay).toEqual([skillEvent]);
  });

  test("deletes a trace file by id", async () => {
    const traceDir = await tempTraceDir();
    const path = buildTracePath(traceDir, "session-delete");
    await appendTraceLine(path, { kind: "session_created", label: "Session created" });

    const files = await listTraceFiles(traceDir);
    expect(files).toHaveLength(1);

    await deleteTraceFile(traceDir, files[0]!.id);

    expect(await listTraceFiles(traceDir)).toHaveLength(0);
  });

  test("captures prompt source information in the input context trace", async () => {
    const emitted: any[] = [];
    const middleware = createTraceMiddleware({
      sessionId: "session-prompt",
      getRequestId: () => "request-1",
      getPromptState: () => ({
        activeVersionId: "version-1",
        runtime: null,
        versions: [{ id: "version-1", name: "v1", source: "prompt_version", prompt: "saved", messages: [], tools: [], versionId: null, createdAt: "2026-05-14T00:00:00.000Z", updatedAt: "2026-05-14T00:00:00.000Z" }],
        draftPrompt: null,
        draftUpdatedAt: null,
      }),
      emit: (event) => {
        emitted.push(event);
      },
      toToolInventory: (tools) => (tools || []).map((tool) => ({ name: tool.name, description: tool.description, parameters: {}, requiresApproval: false })),
    });

    await (middleware.beforeModel as any)?.({
      modelContext: {
        prompt: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [{ name: "bash", description: "Run shell", parameters: { toJSONSchema: () => ({}) }, invoke: async () => null }],
      },
      agentContext: { skills: [], requestedSkillName: "coding-plan", messages: [], prompt: "", tools: [] },
    } as any);

    const inputContext = emitted.find((event) => event.kind === "input_context");
    expect(inputContext?.data?.source).toBe("prompt_version");
    expect(inputContext?.data?.versionId).toBe("version-1");
    expect(inputContext?.data?.versionName).toBe("v1");
  });
});
