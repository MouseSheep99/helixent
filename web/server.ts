import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { type AgentMiddleware } from "@/agent";
import { listSkills } from "@/agent/skills/list-skills";
import type { SkillFrontmatter } from "@/agent/skills/types";
import {
  ensureHelixentHomeDirectory,
  ensureHelixentHomeEnv,
  getConfigFilePath,
  getHelixentHomePath,
  isHelixentSetupComplete,
  loadConfig,
  saveConfig,
  type ModelEntry,
} from "@/cli/config";
import { MODEL_PROVIDERS } from "@/cli/model-providers";
import { SettingsLoader, SettingsWriter } from "@/cli/settings";
import { buildPromptSubmission, formatHelp, loadAvailableCommands, resolveBuiltinCommand } from "@/cli/tui/command-registry";
import { buildTodoViewState } from "@/cli/tui/todo-view";
import { createCodingAgent, type ApprovalDecision, ApprovalManager, AskUserQuestionManager } from "@/coding";
import { AnthropicModelProvider } from "@/community/anthropic";
import { OpenAIModelProvider } from "@/community/openai";
import type { Agent, AgentEvent } from "@/agent";
import type { AskUserQuestionParameters, AskUserQuestionResult } from "@/coding";
import type { ModelProvider, NonSystemMessage, Tool, ToolUseContent, UserMessage } from "@/foundation";
import { Model } from "@/foundation";

import {
  appendTraceLine,
  buildTracePath,
  createTraceEvent,
  createTraceMiddleware,
  deleteTraceFile,
  listTraceFiles,
  readTraceFile,
  summarizeValue,
} from "./trace";
import { HttpError } from "./http-error";
import { buildUserMessageContent, validateWebImageInputs } from "./messages";
import {
  createProjectSkill,
  deleteProjectSkill,
  getProjectSkillsDir,
  listProjectSkills,
  updateProjectSkill,
} from "./skills";
import {
  createPromptVersionRecord,
  deletePromptVersion,
  getActivePromptVersion,
  loadPromptState,
  normalizePromptSnapshot,
  savePromptState,
  setActivePromptVersion,
  setPromptDraft,
  upsertPromptVersion,
} from "./prompt-versions";
import { defaultEnabledToolNames, filterTools, getDefaultToolInventory, toToolInventory } from "./tools";
import type {
  ApprovalResponseBody,
  CreateSessionBody,
  QuestionResponseBody,
  SaveModelConfigBody,
  SaveSkillBody,
  ServerEvent,
  SessionSnapshot,
  SubmitMessageBody,
  TraceEvent,
  ToolInventoryItem,
  UpdateSkillBody,
  WebApprovalRequest,
  WebQuestionRequest,
} from "./types";

type Client = {
  id: string;
  send: (event: ServerEvent) => void;
  close: () => void;
};

type WebSession = {
  id: string;
  cwd: string;
  agent: Agent;
  commands: Awaited<ReturnType<typeof loadAvailableCommands>>;
  skills: SkillFrontmatter[];
  enabledTools: Set<string>;
  tracePath: string;
  promptState: SessionSnapshot["promptState"];
  promptStateWrite: Promise<void>;
  clients: Set<Client>;
  currentRequestId?: string;
  streaming: boolean;
  approvalManager: ApprovalManager;
  askUserQuestionManager: AskUserQuestionManager;
  approvalRequest: WebApprovalRequest | null;
  questionRequest: WebQuestionRequest | null;
};

const ROOT = process.cwd();
const HOST = Bun.env.HOST ?? "127.0.0.1";
const PORT = Number(Bun.env.PORT ?? 4317);

ensureHelixentHomeEnv();
ensureHelixentHomeDirectory();

const sessions = new Map<string, WebSession>();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    try {
      return await route(req);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[web] request failed", message);
      return json({ error: message }, 500);
    }
  },
});

console.info(`Helixent Trace Lens listening on http://${HOST}:${server.port}`);

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" && req.method === "GET") {
    return fileResponse("index.html", "text/html; charset=utf-8");
  }
  if (path.startsWith("/assets/") && req.method === "GET") {
    const file = path.replace("/assets/", "");
    return assetResponse(file, contentType(file));
  }

  if (path === "/api/config/models" && req.method === "GET") {
    return json(getConfigState());
  }
  if (path === "/api/config/models" && req.method === "POST") {
    const body = await readJson<SaveModelConfigBody>(req);
    saveConfig(normalizeModelConfig(body));
    return json(getConfigState());
  }

  if (path === "/api/sessions" && req.method === "POST") {
    const body = await readJson<CreateSessionBody>(req).catch(() => ({}));
    const session = await createSession(body);
    return json(snapshotSession(session), 201);
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const session = getSession(sessionMatch[1]!);
    const action = sessionMatch[2] ?? "";
    if (!action && req.method === "GET") {
      return json(snapshotSession(session));
    }
    if (action === "events" && req.method === "GET") {
      return eventStream(session, req.signal);
    }
    if (action === "prompt" && req.method === "GET") {
      return json({ promptState: session.promptState, activeVersion: getActivePromptVersion(session.promptState) });
    }
    if (action === "prompt/versions" && req.method === "POST") {
      const body = await readJson<{ name: string; snapshot?: unknown }>(req);
      const snapshot = normalizePromptSnapshot((body.snapshot ?? session.promptState.runtime) as
        | Parameters<typeof normalizePromptSnapshot>[0]
        | undefined);
      if (!snapshot.prompt && !snapshot.messages.length && !snapshot.tools.length) {
        throw new HttpError("No prompt snapshot available to save.", 409);
      }
      const version = createPromptVersionRecord(snapshot, body.name?.trim() || `Version ${session.promptState.versions.length + 1}`);
      session.promptState = upsertPromptVersion(session.promptState, version);
      await persistPromptState(session);
      emit(session, { type: "trace", event: trace(session, "prompt_version_saved", `Prompt version saved: ${version.name}`, { version }) });
      return json({ promptState: session.promptState, version }, 201);
    }
    if (action === "prompt/active" && req.method === "POST") {
      const body = await readJson<{ versionId: string | null }>(req);
      if (body.versionId === null) {
        session.promptState = setActivePromptVersion(session.promptState, null);
      } else if (!session.promptState.versions.some((version) => version.id === body.versionId)) {
        throw new HttpError(`Prompt version not found: ${body.versionId}`, 404);
      } else {
        session.promptState = setActivePromptVersion(session.promptState, body.versionId);
      }
      await persistPromptState(session);
      emit(session, {
        type: "trace",
        event: trace(session, "prompt_version_activated", "Prompt version activated", {
          versionId: session.promptState.activeVersionId,
          version: getActivePromptVersion(session.promptState),
        }),
      });
      return json({ promptState: session.promptState, activeVersion: getActivePromptVersion(session.promptState) });
    }
    if (action === "prompt/draft" && req.method === "PUT") {
      const body = await readJson<{ prompt: string | null }>(req);
      const draft = typeof body.prompt === "string" ? body.prompt : null;
      session.promptState = setPromptDraft(session.promptState, draft);
      await persistPromptState(session);
      return json({ promptState: session.promptState });
    }
    if (action === "prompt/draft" && req.method === "DELETE") {
      session.promptState = setPromptDraft(session.promptState, null);
      await persistPromptState(session);
      return json({ promptState: session.promptState });
    }
    const promptVersionMatch = action.match(/^prompt\/versions\/([^/]+)$/);
    if (promptVersionMatch && req.method === "DELETE") {
      const versionId = decodeURIComponent(promptVersionMatch[1]!);
      session.promptState = deletePromptVersion(session.promptState, versionId);
      await persistPromptState(session);
      emit(session, {
        type: "trace",
        event: trace(session, "prompt_version_deleted", "Prompt version removed", {
          versionId,
          activeVersionId: session.promptState.activeVersionId,
        }),
      });
      return json({ promptState: session.promptState });
    }
    if (action === "messages" && req.method === "POST") {
      const body = await readJson<SubmitMessageBody>(req);
      await submitMessage(session, body);
      return json({ ok: true });
    }
    if (action === "approval" && req.method === "POST") {
      const body = await readJson<ApprovalResponseBody>(req);
      respondToApproval(session, body.decision);
      return json({ ok: true });
    }
    if (action === "question-answer" && req.method === "POST") {
      const body = await readJson<QuestionResponseBody>(req);
      respondToQuestion(session, body.result);
      return json({ ok: true });
    }
    if (action === "abort" && req.method === "POST") {
      session.agent.abort();
      emit(session, { type: "trace", event: trace(session, "session_aborted", "Current run aborted") });
      return json({ ok: true });
    }
    if (action === "clear" && req.method === "POST") {
      session.agent.clearMessages();
      session.currentRequestId = undefined;
      emit(session, { type: "trace", event: trace(session, "session_cleared", "Session messages cleared") });
      emit(session, { type: "todo_update", todos: undefined });
      return json({ ok: true });
    }
    if (action === "tools/enabled" && req.method === "POST") {
      const body = await readJson<{ tools: string[] }>(req);
      session.enabledTools = new Set(body.tools);
      emit(session, {
        type: "trace",
        event: trace(session, "tool_enabled_updated", "Enabled tools updated", { tools: body.tools }),
      });
      return json(snapshotSession(session));
    }
  }

  if (path === "/api/tools" && req.method === "GET") {
    return json({ tools: getDefaultToolInventory(new Set(defaultEnabledToolNames())) });
  }

  if (path === "/api/skills" && req.method === "GET") {
    return json({ skills: await listProjectSkills(ROOT), directory: getProjectSkillsDir(ROOT) });
  }
  if (path === "/api/skills" && req.method === "POST") {
    const body = await readJson<SaveSkillBody>(req);
    const skill = await createProjectSkill(body, ROOT);
    await refreshSessionCommands();
    return json({ skill }, 201);
  }

  const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch) {
    const slug = decodeURIComponent(skillMatch[1]!);
    if (req.method === "PUT") {
      const body = await readJson<UpdateSkillBody>(req);
      const skill = await updateProjectSkill(slug, body, ROOT);
      await refreshSessionCommands();
      return json({ skill });
    }
    if (req.method === "DELETE") {
      await deleteProjectSkill(slug, ROOT);
      await refreshSessionCommands();
      return json({ ok: true });
    }
  }

  if (path === "/api/traces" && req.method === "GET") {
    return json({ traces: await listTraceFiles(getTraceDir()) });
  }
  const traceMatch = path.match(/^\/api\/traces\/([^/]+)$/);
  if (traceMatch && req.method === "GET") {
    const traceId = decodeURIComponent(traceMatch[1]!);
    return json({ id: traceId, events: await readTraceFile(getTraceDir(), traceId) });
  }
  if (traceMatch && req.method === "DELETE") {
    const traceId = decodeURIComponent(traceMatch[1]!);
    await deleteTraceFile(getTraceDir(), traceId);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function createSession(body: CreateSessionBody): Promise<WebSession> {
  if (!isHelixentSetupComplete()) {
    throw new HttpError("Model config is missing. Configure a model first.", 409);
  }

  const cwd = body.cwd?.trim() || ROOT;
  const config = loadConfig();
  const modelEntry = resolveModelEntry(config.models, config.defaultModel);
  const model = new Model(modelEntry.name, createModelProvider(modelEntry), {
    max_tokens: 16 * 1024,
    thinking: { type: "enabled" },
  });

  const sessionId = crypto.randomUUID();
  const tracePath = buildTracePath(getTraceDir(), sessionId);
  const promptState = await loadPromptState(sessionId);
  const enabledTools = new Set(body.enabledTools?.length ? body.enabledTools : defaultEnabledToolNames());
  const approvalManager = new ApprovalManager();
  const askUserQuestionManager = new AskUserQuestionManager();
  const settingsLoader = new SettingsLoader();
  const settingsWriter = new SettingsWriter(settingsLoader);
  const skillsDirs = getSkillsDirs(cwd);

  const agent = await createCodingAgent({
    model,
    cwd,
    skillsDirs,
    askUser: approvalManager.askUser,
    askUserQuestion: askUserQuestionManager.askUserQuestion,
    approvalPersistence: {
      loadAllowList: (projectCwd) => settingsLoader.loadAllowList(projectCwd),
      persistAllowedTool: (projectCwd, toolName) => settingsWriter.appendAllowedTool(projectCwd, toolName),
    },
  });

  const session: WebSession = {
    id: sessionId,
    cwd,
    agent,
    commands: await loadAvailableCommands(skillsDirs),
    skills: await listSkills(skillsDirs),
    enabledTools,
    tracePath,
    promptState,
    promptStateWrite: Promise.resolve(),
    clients: new Set(),
    streaming: false,
    approvalManager,
    askUserQuestionManager,
    approvalRequest: null,
    questionRequest: null,
  };

  installToolFilter(session);
  installPromptMiddleware(session);
  installTraceMiddleware(session);
  wrapSessionTools(session);
  subscribeHumanQueues(session);

  // Prefill runtime snapshot before the first run so the prompt editor shows the agent's
  // initial system prompt / messages / tools instead of being empty until beforeModel fires.
  session.promptState = {
    ...session.promptState,
    runtime: normalizePromptSnapshot({
      source: "runtime",
      prompt: session.agent.prompt,
      messages: session.agent.messages,
      tools: toToolInventory(session.agent.tools, session.enabledTools),
      requestedSkillName: null,
    }),
  };
  void persistPromptState(session);

  sessions.set(session.id, session);
  emit(session, { type: "trace", event: trace(session, "session_created", "Session created", { cwd, model: modelEntry.name }) });
  return session;
}

async function submitMessage(session: WebSession, body: SubmitMessageBody) {
  const text = body.text?.trim() ?? "";
  const images = validateWebImageInputs(body.images);
  if (!text && images.length === 0) {
    throw new HttpError("Message text is required.", 400);
  }
  if (session.streaming) {
    throw new HttpError("Agent is already running.", 409);
  }

  const invocation = text ? resolveBuiltinCommand(text) : null;
  if (invocation?.name === "clear") {
    session.agent.clearMessages();
    emit(session, { type: "trace", event: trace(session, "session_cleared", "Session messages cleared") });
    emit(session, { type: "todo_update", todos: undefined });
    return;
  }
  if (invocation?.name === "help") {
    const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
    const assistantMessage: NonSystemMessage = {
      role: "assistant",
      content: [{ type: "text", text: formatHelp(session.commands, invocation.args || undefined) }],
    };
    emit(session, { type: "message", message: userMessage });
    emit(session, { type: "message", message: assistantMessage });
    return;
  }
  if (invocation?.name === "exit" || invocation?.name === "quit") {
    emit(session, { type: "error", message: "Exit is only available in the terminal UI." });
    return;
  }

  const requestId = crypto.randomUUID();
  session.currentRequestId = requestId;
  session.streaming = true;
  emit(session, { type: "streaming_state", streaming: true });
  const submission = buildPromptSubmission(text, session.commands);
  const requestedSkillName = body.requestedSkillName ?? submission.requestedSkillName;
  const userMessage: UserMessage = {
    role: "user",
    content: buildUserMessageContent(text, images),
  };
  emit(session, { type: "message", message: userMessage });
  emit(session, {
    type: "trace",
    event: trace(session, "user_message", "User message", {
      role: "user",
      content: userMessage.content,
    }),
  });

  void (async () => {
    try {
      session.agent.setRequestedSkillName(requestedSkillName);
      for await (const event of session.agent.stream(userMessage)) {
        emit(session, { type: "agent", event });
        if (event.type === "progress") {
          emit(session, {
            type: "trace",
            event: trace(session, "agent_progress", formatProgressLabel(event), { progress: event }),
          });
        }
        if (event.type === "message") {
          emit(session, { type: "message", message: event.message });
          const todoState = buildTodoViewState(session.agent.messages);
          if ((todoState.latestTodos?.length ?? 0) > 0) {
            emit(session, { type: "todo_update", todos: todoState.latestTodos });
          }
        }
      }
    } catch (error) {
      const message = isAbortError(error) ? "Run aborted." : error instanceof Error ? error.message : String(error);
      emit(session, { type: "error", message });
    } finally {
      session.agent.setRequestedSkillName(null);
      session.currentRequestId = undefined;
      session.streaming = false;
      emit(session, { type: "streaming_state", streaming: false });
    }
  })();
}

function installToolFilter(session: WebSession) {
  const middleware: AgentMiddleware = {
    beforeModel: async ({ modelContext }) => {
      return { tools: filterTools(modelContext.tools, session.enabledTools) };
    },
    beforeToolUse: async ({ toolUse }) => {
      if (session.enabledTools.has(toolUse.name)) return;
      const event = trace(session, "tool_disabled", `Tool disabled: ${toolUse.name}`, { toolUse });
      emit(session, { type: "trace", event });
      return {
        __skip: true,
        result: `Tool ${toolUse.name} is disabled for this web session.`,
      };
    },
  };
  insertBeforeApproval(session.agent, middleware);
}

function installPromptMiddleware(session: WebSession) {
  const middleware: AgentMiddleware = {
    beforeModel: async ({ modelContext, agentContext }) => {
      const runtime = normalizePromptSnapshot({
        source: "runtime",
        prompt: modelContext.prompt,
        messages: modelContext.messages,
        tools: toToolInventory(modelContext.tools, session.enabledTools),
        requestedSkillName: agentContext.requestedSkillName ?? null,
      });

      const activeVersion = getActivePromptVersion(session.promptState);
      const draftPrompt = session.promptState.draftPrompt;
      const hasDraft = typeof draftPrompt === "string" && draftPrompt.length > 0;

      if (!activeVersion && !hasDraft) {
        session.promptState = {
          ...session.promptState,
          runtime,
        };
        void persistPromptState(session);
        return;
      }

      const baseSnapshot = activeVersion
        ? normalizePromptSnapshot({
            ...activeVersion,
            source: "prompt_version",
            versionId: activeVersion.id,
          })
        : runtime;

      const applied = hasDraft
        ? normalizePromptSnapshot({
            ...baseSnapshot,
            source: "draft",
            prompt: draftPrompt!,
          })
        : baseSnapshot;

      session.promptState = {
        ...session.promptState,
        runtime: applied,
      };
      void persistPromptState(session);

      const traceLabel = hasDraft
        ? activeVersion
          ? `Prompt draft applied over version: ${activeVersion.name}`
          : "Prompt draft applied"
        : `Prompt version applied: ${activeVersion!.name}`;

      emit(session, {
        type: "trace",
        event: trace(session, "prompt_version_applied", traceLabel, {
          versionId: activeVersion?.id ?? null,
          versionName: activeVersion?.name ?? null,
          source: hasDraft ? "draft" : "prompt_version",
          draftActive: hasDraft,
          runtimeSummary: summarizePromptSnapshot(runtime),
          appliedSummary: summarizePromptSnapshot(applied),
        }),
      });

      if (!activeVersion) {
        return { prompt: applied.prompt };
      }

      const versionToolNames = new Set(applied.tools.map((tool) => tool.name));
      return {
        prompt: applied.prompt,
        messages: applied.messages,
        tools: filterTools(modelContext.tools, versionToolNames),
      };
    },
  };
  insertBeforeSkills(session.agent, middleware);
}

function installTraceMiddleware(session: WebSession) {
  const middleware = createTraceMiddleware({
    sessionId: session.id,
    getRequestId: () => session.currentRequestId,
    emit: async (event) => emit(session, { type: event.kind === "hook_triggered" ? "hook" : "trace", event }),
    toToolInventory: (tools) => toToolInventory(tools, session.enabledTools),
    getPromptState: () => session.promptState,
  });
  insertBeforeApproval(session.agent, middleware);
}

function wrapSessionTools(session: WebSession) {
  const tools = session.agent.tools;
  if (!tools) return;
  for (const [index, tool] of tools.entries()) {
    tools[index] = {
      ...tool,
      invoke: async (input, signal) => {
        const toolUse = { name: tool.name, input };
        emit(session, {
          type: "trace",
          event: trace(session, "tool_execution_started", `Tool started: ${tool.name}`, { toolUse }),
        });
        try {
          const result = await tool.invoke(input, signal);
          emit(session, {
            type: "trace",
            event: trace(session, "tool_execution_completed", `Tool completed: ${tool.name}`, {
              toolUse,
              resultSummary: summarizeValue(result),
            }),
          });
          emitSkillLoadedIfNeeded(session, tool.name, input);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit(session, {
            type: "trace",
            event: trace(session, "tool_execution_completed", `Tool failed: ${tool.name}`, {
              toolUse,
              error: message,
            }),
          });
          throw error;
        }
      },
    };
  }
}

function emitSkillLoadedIfNeeded(session: WebSession, toolName: string, input: unknown) {
  if (toolName !== "read_file") return;
  const path = typeof input === "object" && input !== null ? (input as { path?: unknown }).path : null;
  if (typeof path !== "string") return;
  const normalizedPath = resolve(path);
  const skill = session.skills.find((item) => resolve(item.path) === normalizedPath);
  if (!skill) return;
  emit(session, {
    type: "trace",
    event: trace(session, "skill_loaded", `Skill loaded: /${skill.name}`, {
      skill,
      path: normalizedPath,
      selectedBy: "model_read_file",
    }),
  });
}

function subscribeHumanQueues(session: WebSession) {
  session.approvalManager.subscribe((req) => {
    if (!req) {
      session.approvalRequest = null;
      emit(session, { type: "approval", request: null });
      return;
    }
    const request = { id: crypto.randomUUID(), toolUse: req.toolUse };
    session.approvalRequest = request;
    emit(session, { type: "approval", request });
    emit(session, {
      type: "trace",
      event: trace(session, "approval_requested", `Approval requested: ${req.toolUse.name}`, { toolUse: req.toolUse }),
    });
  });

  session.askUserQuestionManager.subscribe((req) => {
    if (!req) {
      session.questionRequest = null;
      emit(session, { type: "question", request: null });
      return;
    }
    const request = { id: crypto.randomUUID(), params: req.params };
    session.questionRequest = request;
    emit(session, { type: "question", request });
    emit(session, {
      type: "trace",
      event: trace(session, "question_requested", "Agent asked user a question", { params: req.params }),
    });
  });
}

function respondToApproval(session: WebSession, decision: ApprovalDecision) {
  session.approvalManager.respond(decision);
  emit(session, {
    type: "trace",
    event: trace(session, "approval_resolved", `Approval resolved: ${decision}`, {
      decision,
      request: session.approvalRequest,
    }),
  });
  session.approvalRequest = null;
  emit(session, { type: "approval", request: null });
}

function respondToQuestion(session: WebSession, result: AskUserQuestionResult) {
  session.askUserQuestionManager.respondWithAnswers(result);
  emit(session, {
    type: "trace",
    event: trace(session, "question_resolved", "Question answered", { result }),
  });
  session.questionRequest = null;
  emit(session, { type: "question", request: null });
}

function insertBeforeApproval(agent: Agent, middleware: AgentMiddleware) {
  const index = Math.max(0, agent.middlewares.length - 1);
  agent.middlewares.splice(index, 0, middleware);
}

function insertBeforeSkills(agent: Agent, middleware: AgentMiddleware) {
  agent.middlewares.unshift(middleware);
}

function emit(session: WebSession, event: ServerEvent) {
  if (event.type === "trace" || event.type === "hook") {
    void appendTraceLine(session.tracePath, event.event);
  } else if (event.type === "message") {
    void appendTraceLine(session.tracePath, event);
  } else if (event.type === "todo_update") {
    if ((event.todos ?? []).length > 0) {
      void appendTraceLine(session.tracePath, trace(session, "todo_update", "Todo panel updated", { todos: event.todos ?? [] }));
    }
  } else if (event.type === "error") {
    void appendTraceLine(session.tracePath, trace(session, "error", event.message, { message: event.message }));
  }
  for (const client of session.clients) {
    client.send(event);
  }
}

function trace(session: WebSession, kind: TraceEvent["kind"], label: string, data?: Record<string, unknown>) {
  return createTraceEvent({
    sessionId: session.id,
    requestId: session.currentRequestId,
    kind,
    label,
    data,
  });
}

function eventStream(session: WebSession, signal: AbortSignal) {
  const encoder = new TextEncoder();
  let client: Client;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        id: crypto.randomUUID(),
        send(event) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        },
        close() {
          controller.close();
        },
      };
      session.clients.add(client);
      client.send({ type: "ready", sessionId: session.id, commands: session.commands });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 15000);
      signal.addEventListener(
        "abort",
        () => {
          if (heartbeat) clearInterval(heartbeat);
          session.clients.delete(client);
          try {
            client.close();
          } catch {
            // client already closed
          }
        },
        { once: true },
      );
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (client) session.clients.delete(client);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function refreshSessionCommands() {
  for (const session of sessions.values()) {
    session.commands = await loadAvailableCommands(getSkillsDirs(session.cwd));
    session.skills = await listSkills(getSkillsDirs(session.cwd));
    emit(session, { type: "commands", commands: session.commands });
  }
}

function snapshotSession(session: WebSession): SessionSnapshot {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    model: session.agent.model.name,
    commands: session.commands,
    tools: toToolInventory(session.agent.tools, session.enabledTools),
    messages: session.agent.messages,
    promptState: session.promptState,
  };
}

function summarizePromptSnapshot(snapshot: ReturnType<typeof normalizePromptSnapshot>) {
  return {
    source: snapshot.source,
    versionId: snapshot.versionId ?? null,
    name: snapshot.name ?? null,
    promptPreview: summarizeValue(snapshot.prompt, 300),
    messageCount: snapshot.messages.length,
    toolCount: snapshot.tools.length,
    requestedSkillName: snapshot.requestedSkillName ?? null,
  };
}

async function persistPromptState(session: WebSession) {
  const snapshot = structuredClone(session.promptState);
  session.promptStateWrite = session.promptStateWrite
    .then(() => savePromptState(session.id, snapshot))
    .then((next) => {
      session.promptState = next;
    })
    .catch((error) => {
      console.error("[web] failed to persist prompt state", error);
    });
  return session.promptStateWrite;
}

function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) {
    throw new HttpError(`Session not found: ${id}`, 404);
  }
  return session;
}

function resolveModelEntry(models: ModelEntry[], defaultModel?: string): ModelEntry {
  const entry = defaultModel ? models.find((model) => model.name === defaultModel) : models[0];
  if (!entry) {
    throw new HttpError("No model configured.", 409);
  }
  return entry;
}

function createModelProvider(entry: ModelEntry): ModelProvider {
  if (entry.provider === "anthropic") {
    return new AnthropicModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
  }
  return new OpenAIModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
}

function getSkillsDirs(cwd: string) {
  return [
    join(cwd, "skills"),
    join(cwd, ".agents/skills"),
    join(getHelixentHomePath(), "skills"),
    "~/.agents/skills",
    "~/.helixent/skills",
  ];
}

function getTraceDir() {
  const dir = join(getHelixentHomePath(), "traces");
  void mkdir(dir, { recursive: true });
  return dir;
}

function getConfigState() {
  if (!isHelixentSetupComplete() || !existsSync(getConfigFilePath())) {
    return {
      setupRequired: true,
      configPath: getConfigFilePath(),
      providers: MODEL_PROVIDERS,
    };
  }
  const config = loadConfig();
  return {
    setupRequired: false,
    configPath: getConfigFilePath(),
    providers: MODEL_PROVIDERS,
    defaultModel: config.defaultModel ?? config.models[0]?.name,
    models: config.models.map((model) => ({
      name: model.name,
      baseURL: model.baseURL,
      provider: model.provider,
      hasAPIKey: model.APIKey.length > 0,
      APIKeyPreview: maskSecret(model.APIKey),
    })),
  };
}

function normalizeModelConfig(body: SaveModelConfigBody) {
  const existingModels = safeLoadExistingModels();
  const existingKeys = new Map(existingModels.map((model) => [model.name, model.APIKey]));
  return {
    ...body,
    models: body.models.map((model) => ({
      ...model,
      APIKey: model.APIKey?.trim() || existingKeys.get(model.name) || "",
      provider: model.provider ?? "openai",
    })),
  };
}

function safeLoadExistingModels(): ModelEntry[] {
  try {
    if (!isHelixentSetupComplete()) return [];
    return loadConfig().models;
  } catch {
    return [];
  }
}

async function fileResponse(fileName: string, type: string) {
  const file = Bun.file(join(import.meta.dir, "public", basename(fileName)));
  if (!(await file.exists())) {
    return json({ error: "Not found" }, 404);
  }
  return new Response(file, { headers: { "Content-Type": type } });
}

async function assetResponse(fileName: string, type: string) {
  const publicDir = join(import.meta.dir, "public");
  const target = resolve(publicDir, fileName);
  if (!target.startsWith(publicDir + "/") && target !== publicDir) {
    return json({ error: "Not found" }, 404);
  }
  const file = Bun.file(target);
  if (!(await file.exists())) {
    return json({ error: "Not found" }, 404);
  }
  return new Response(file, { headers: { "Content-Type": type } });
}

function contentType(file: string) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function readJson<T>(req: Request): Promise<T> {
  const body = await req.text();
  if (!body.trim()) return {} as T;
  return JSON.parse(body) as T;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function maskSecret(value: string) {
  if (!value) return "";
  return value.slice(-6).padStart(Math.min(value.length, 10), "*");
}

function formatProgressLabel(event: AgentEvent) {
  if (event.type !== "progress") return "Agent progress";
  if (event.subtype === "tool") return `Tool progress: ${event.name}`;
  return "Agent thinking";
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof Error && error.constructor.name === "APIUserAbortError") return true;
  return false;
}

