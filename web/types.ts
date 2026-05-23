import type { AgentEvent } from "@/agent";
import type { AskUserQuestionParameters, AskUserQuestionResult } from "@/coding";
import type { ApprovalDecision } from "@/coding/permissions";
import type { AssistantMessage, Message, NonSystemMessage, ToolUseContent } from "@/foundation";

import type { SlashCommand } from "../src/cli/tui/command-registry";

export type TraceKind =
  | "input_context"
  | "prompt_version_applied"
  | "model_output_block"
  | "tool_call_detected"
  | "hook_triggered"
  | "tool_execution_started"
  | "tool_execution_completed"
  | "approval_requested"
  | "approval_resolved"
  | "question_requested"
  | "question_resolved"
  | "skills_inventory"
  | "skill_system_injected"
  | "skill_loaded"
  | "session_created"
  | "session_cleared"
  | "session_aborted"
  | "prompt_version_saved"
  | "prompt_version_activated"
  | "prompt_version_deleted"
  | "tool_enabled_updated"
  | "tool_disabled"
  | "token_usage"
  | "todo_update"
  | "agent_progress"
  | "error";

export interface TraceEvent {
  id: string;
  sessionId: string;
  requestId?: string;
  kind: TraceKind;
  at: string;
  label: string;
  data?: Record<string, unknown>;
}

export type ServerEvent =
  | { type: "ready"; sessionId: string; commands: SlashCommand[] }
  | { type: "agent"; event: AgentEvent }
  | { type: "streaming_state"; streaming: boolean }
  | { type: "message"; message: NonSystemMessage }
  | { type: "trace"; event: TraceEvent }
  | { type: "hook"; event: TraceEvent }
  | { type: "approval"; request: WebApprovalRequest | null }
  | { type: "question"; request: WebQuestionRequest | null }
  | { type: "todo_update"; todos?: WebTodoItem[] }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "error"; message: string };

export interface WebApprovalRequest {
  id: string;
  toolUse: ToolUseContent;
}

export interface WebQuestionRequest {
  id: string;
  params: AskUserQuestionParameters;
}

export interface WebTodoItem {
  id: string;
  content: string;
  status: string;
}

export interface ToolInventoryItem {
  name: string;
  description: string;
  parameters: unknown;
  requiresApproval: boolean;
  enabled?: boolean;
}

export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  slug: string;
  content: string;
}

export interface SessionSnapshot {
  sessionId: string;
  cwd: string;
  model: string;
  commands: SlashCommand[];
  tools: ToolInventoryItem[];
  messages: NonSystemMessage[];
  promptState: PromptState;
}

export interface CreateSessionBody {
  cwd?: string;
  enabledTools?: string[];
}

export type WebImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface WebImageInput {
  /** Optional original filename (display only). */
  name?: string;
  /** Mime type of the encoded image. */
  mimeType: WebImageMimeType;
  /** Full data URL: `data:<mimeType>;base64,<b64>`. */
  dataUrl: string;
  /** Decoded byte size, used for server-side size validation. */
  size?: number;
  /** Optional vision detail hint, forwarded to provider via `image_url.detail`. */
  detail?: "auto" | "high" | "low";
}

export interface SubmitMessageBody {
  text: string;
  requestedSkillName?: string | null;
  /**
   * Optional inline images attached to this user turn. When present, the server
   * validates and emits a multimodal `UserMessage` with `image_url` segments
   * preceding the text segment (image-before-text best practice).
   */
  images?: WebImageInput[];
}

export interface PromptSnapshot {
  source: "runtime" | "prompt_version" | "draft";
  versionId?: string | null;
  name?: string | null;
  prompt: string;
  messages: NonSystemMessage[];
  tools: ToolInventoryItem[];
  requestedSkillName?: string | null;
}

export interface PromptVersionRecord extends PromptSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptState {
  activeVersionId: string | null;
  runtime: PromptSnapshot | null;
  versions: PromptVersionRecord[];
  draftPrompt: string | null;
  draftUpdatedAt: string | null;
}

export interface SavePromptVersionBody {
  name: string;
  snapshot: Omit<PromptSnapshot, "source" | "versionId"> & {
    source?: PromptSnapshot["source"];
    versionId?: string | null;
  };
}

export interface SetPromptVersionActiveBody {
  versionId: string | null;
}

export interface SaveModelConfigBody {
  models: Array<{
    name: string;
    baseURL: string;
    APIKey?: string;
    provider?: "openai" | "anthropic";
  }>;
  defaultModel?: string;
}

export interface SaveSkillBody {
  name: string;
  description: string;
  content?: string;
}

export interface UpdateSkillBody {
  name?: string;
  description?: string;
  content: string;
}

export interface ApprovalResponseBody {
  decision: ApprovalDecision;
}

export interface QuestionResponseBody {
  result: AskUserQuestionResult;
}

export interface TraceFile {
  id: string;
  path: string;
  size: number;
  modifiedTime: string;
}

export interface TraceReplay {
  id: string;
  events: Array<TraceEvent | { type: string; [key: string]: unknown }>;
}

export interface InputContextTraceData {
  prompt: string;
  messages: Message[];
  tools: ToolInventoryItem[];
  model?: string;
  options?: Record<string, unknown>;
  source?: "runtime" | "prompt_version";
  versionId?: string | null;
  versionName?: string | null;
  requestedSkillName?: string | null;
}

export interface ModelOutputBlockTraceData {
  message: AssistantMessage;
  blockIndex: number;
  block: AssistantMessage["content"][number];
}
