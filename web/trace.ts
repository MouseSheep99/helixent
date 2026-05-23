import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentMiddleware } from "@/agent";
import type { AssistantMessage, Tool, ToolUseContent } from "@/foundation";

import type { PromptState } from "./types";
import type { TraceEvent, TraceFile, TraceKind, ToolInventoryItem } from "./types";

export type EmitTrace = (event: TraceEvent) => void | Promise<void>;

export function createTraceEvent({
  sessionId,
  requestId,
  kind,
  label,
  data,
}: {
  sessionId: string;
  requestId?: string;
  kind: TraceKind;
  label: string;
  data?: Record<string, unknown>;
}): TraceEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ...(requestId ? { requestId } : {}),
    kind,
    at: new Date().toISOString(),
    label,
    ...(data ? { data } : {}),
  };
}

export function createTraceMiddleware({
  sessionId,
  getRequestId,
  getPromptState,
  emit,
  toToolInventory,
}: {
  sessionId: string;
  getRequestId: () => string | undefined;
  getPromptState: () => PromptState;
  emit: EmitTrace;
  toToolInventory: (tools?: Tool[]) => ToolInventoryItem[];
}): AgentMiddleware {
  const hookStartedAt = new Map<string, number>();

  const hook = async (name: string, data?: Record<string, unknown>) => {
    const key = `${name}:${getRequestId() ?? "session"}`;
    const now = Date.now();
    const previous = hookStartedAt.get(key);
    hookStartedAt.set(key, now);
    await emit(
      createTraceEvent({
        sessionId,
        requestId: getRequestId(),
        kind: "hook_triggered",
        label: name,
        data: {
          hook: name,
          ...(previous ? { msSincePrevious: now - previous } : {}),
          ...safePayload(data),
        },
      }),
    );
  };

  return {
    beforeAgentRun: async ({ agentContext }) => {
      await hook("beforeAgentRun", {
        messageCount: agentContext.messages.length,
        requestedSkillName: agentContext.requestedSkillName ?? null,
      });
    },
    afterAgentRun: async ({ agentContext }) => {
      await hook("afterAgentRun", { messageCount: agentContext.messages.length });
    },
    beforeAgentStep: async ({ step }) => {
      await hook("beforeAgentStep", { step });
    },
    afterAgentStep: async ({ step }) => {
      await hook("afterAgentStep", { step });
    },
    beforeModel: async ({ modelContext, agentContext }) => {
      const promptState = getPromptState();
      const activeVersion = promptState.activeVersionId
        ? promptState.versions.find((version) => version.id === promptState.activeVersionId) || null
        : null;
      const promptSource = typeof promptState.draftPrompt === "string" && promptState.draftPrompt.length > 0
        ? "draft"
        : activeVersion
          ? "prompt_version"
          : "runtime";
      await hook("beforeModel", {
        messageCount: modelContext.messages.length,
        toolCount: modelContext.tools?.length ?? 0,
        skills: agentContext.skills ?? [],
      });
      await emit(
        createTraceEvent({
          sessionId,
          requestId: getRequestId(),
          kind: "input_context",
          label: "Input context sent to model",
          data: {
            prompt: modelContext.prompt,
            messages: modelContext.messages,
            tools: toToolInventory(modelContext.tools),
            requestedSkillName: agentContext.requestedSkillName ?? null,
            source: promptSource,
            versionId: activeVersion?.id ?? null,
            versionName: activeVersion?.name ?? null,
          },
        }),
      );
      if (agentContext.skills && agentContext.skills.length > 0) {
        await emit(
          createTraceEvent({
            sessionId,
            requestId: getRequestId(),
            kind: "skills_inventory",
            label: `${agentContext.skills.length} skill(s) available`,
            data: { skills: agentContext.skills },
          }),
        );
        await emit(
          createTraceEvent({
            sessionId,
            requestId: getRequestId(),
            kind: "skill_system_injected",
            label: "Skill system injected into prompt",
            data: {
              skillNames: agentContext.skills.map((skill) => skill.name),
              requestedSkillName: agentContext.requestedSkillName ?? null,
            },
          }),
        );
      }
    },
    afterModel: async ({ message }) => {
      await hook("afterModel", {
        blockCount: message.content.length,
        toolUseCount: extractToolUses(message).length,
        usage: message.usage,
      });
      if (message.usage) {
        await emit(
          createTraceEvent({
            sessionId,
            requestId: getRequestId(),
            kind: "token_usage",
            label: "Token usage",
            data: { usage: message.usage },
          }),
        );
      }
      for (const [blockIndex, block] of message.content.entries()) {
        await emit(
          createTraceEvent({
            sessionId,
            requestId: getRequestId(),
            kind: "model_output_block",
            label: `Model output: ${block.type}`,
            data: { blockIndex, block },
          }),
        );
        if (block.type === "tool_use") {
          await emit(
            createTraceEvent({
              sessionId,
              requestId: getRequestId(),
              kind: "tool_call_detected",
              label: `Runtime detected tool call: ${block.name}`,
              data: { blockIndex, toolUse: block },
            }),
          );
        }
      }
    },
    beforeToolUse: async ({ toolUse }) => {
      await hook("beforeToolUse", { toolUse });
    },
    afterToolUse: async ({ toolUse, toolResult }) => {
      await hook("afterToolUse", {
        toolUse,
        resultSummary: summarizeValue(toolResult),
      });
    },
  };
}

export async function appendTraceLine(tracePath: string, value: unknown) {
  await mkdir(dirname(tracePath), { recursive: true });
  await appendFile(tracePath, JSON.stringify(value) + "\n", "utf8");
}

export async function listTraceFiles(traceDir: string): Promise<TraceFile[]> {
  await mkdir(traceDir, { recursive: true });
  const entries = await readdir(traceDir, { withFileTypes: true });
  const files: TraceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(traceDir, entry.name);
    const info = await stat(path);
    files.push({
      id: entry.name.replace(/\.jsonl$/, ""),
      path,
      size: info.size,
      modifiedTime: info.mtime.toISOString(),
    });
  }
  return files.sort((left, right) => right.modifiedTime.localeCompare(left.modifiedTime));
}

export async function readTraceFile(traceDir: string, traceId: string) {
  const safeId = traceId.replace(/[^a-zA-Z0-9_.-]/g, "");
  const content = await readFile(join(traceDir, `${safeId}.jsonl`), "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { type: "parse_error", line };
      }
    });
}

export async function deleteTraceFile(traceDir: string, traceId: string) {
  const safeId = traceId.replace(/[^a-zA-Z0-9_.-]/g, "");
  await unlink(join(traceDir, `${safeId}.jsonl`));
}

export function buildTracePath(traceDir: string, sessionId: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(traceDir, `${stamp}-${sessionId}.jsonl`);
}

export function summarizeValue(value: unknown, maxLength = 800) {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "[unserializable]";
    }
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function extractToolUses(message: AssistantMessage): ToolUseContent[] {
  return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
}

function safePayload(data?: Record<string, unknown>) {
  if (!data) return {};
  return JSON.parse(JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === "function") return "[function]";
    if (value instanceof AbortSignal) return "[AbortSignal]";
    return value;
  })) as Record<string, unknown>;
}
