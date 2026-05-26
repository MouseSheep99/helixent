import type { AssistantMessage, UserMessage } from "@/foundation";

import {
  BUILTIN_COMMANDS,
  formatHelp,
  isCommandAvailableOn,
  type BuiltinCommandName,
  type SlashCommand,
  type SlashCommandSurface,
  type SlashParseResult,
} from "./command-registry";

/**
 * Surface where a command is being dispatched. This drives availability checks
 * (e.g. /exit is cli-only) so the same dispatcher can serve both CLI and Web.
 */
export type DispatchContext = SlashCommandSurface;

/**
 * Side-effect intents that the caller (CLI hook or Web server) translates into
 * its own environment. We keep these as data, not callbacks, so dispatcher stays
 * pure and trivially testable.
 */
export type StateMutation =
  | { kind: "clear-agent-messages" }
  | { kind: "clear-todos" }
  | { kind: "clear-trace" }
  | { kind: "exit-process" };

/**
 * Outcome of dispatching a parsed slash input.
 *
 * - `noop`: caller should fall through to the regular plain-message flow.
 * - `state-mutation`: caller should execute the listed mutations and announce them.
 * - `render-message`: caller should render the user message + assistant reply
 *   (used by /help). The dispatcher provides both messages so CLI and Web emit
 *   identical content.
 * - `unsupported`: command exists but is not available on this surface (e.g. /exit
 *   in the web). Caller should surface a one-liner notice to the user.
 * - `unknown-command`: input looked like /xxx but matched no command. Caller may
 *   still forward the literal text to the model after warning the user.
 * - `skill-passthrough`: command resolves to a skill. Caller should treat the
 *   input as a regular user message but set requestedSkillName.
 */
export type DispatchResult =
  | { kind: "noop" }
  | { kind: "state-mutation"; name: BuiltinCommandName; mutations: StateMutation[]; userMessage: UserMessage }
  | { kind: "render-message"; name: BuiltinCommandName; userMessage: UserMessage; assistantMessage: AssistantMessage }
  | { kind: "unsupported"; name: BuiltinCommandName; reason: "cli-only" }
  | { kind: "unknown-command"; name: string; args: string }
  | { kind: "skill-passthrough"; skillName: string; args: string };

/**
 * Pure mapping from a parsed slash input to a `DispatchResult` for the given
 * surface. The merged commands list must include builtins + skills so /help
 * can render a complete listing.
 */
export function dispatch(
  parseResult: SlashParseResult,
  context: DispatchContext,
  commands: ReadonlyArray<SlashCommand>,
): DispatchResult {
  switch (parseResult.kind) {
    case "not-slash":
      return { kind: "noop" };

    case "skill":
      return { kind: "skill-passthrough", skillName: parseResult.name, args: parseResult.args };

    case "unknown":
      return { kind: "unknown-command", name: parseResult.raw, args: parseResult.args };

    case "builtin": {
      const definition = BUILTIN_COMMANDS.find((c) => c.name === parseResult.name);
      if (definition && !isCommandAvailableOn(definition, context)) {
        return { kind: "unsupported", name: parseResult.name, reason: "cli-only" };
      }
      return dispatchBuiltin(parseResult.name, parseResult.args, commands);
    }
  }
}

function dispatchBuiltin(
  name: BuiltinCommandName,
  args: string,
  commands: ReadonlyArray<SlashCommand>,
): DispatchResult {
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: args ? `/${name} ${args}` : `/${name}` }],
  };

  switch (name) {
    case "clear":
      return {
        kind: "state-mutation",
        name,
        userMessage,
        mutations: [{ kind: "clear-agent-messages" }, { kind: "clear-todos" }, { kind: "clear-trace" }],
      };

    case "exit":
    case "quit":
      return {
        kind: "state-mutation",
        name,
        userMessage,
        mutations: [{ kind: "exit-process" }],
      };

    case "help": {
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: formatHelp(commands as SlashCommand[], args || undefined) }],
        // Synthetic UI-only response; never produced by the model. The Web/CLI
        // renderers use this flag to bypass `__skipModelOutput`-style heuristics
        // that assume a paired `model_output_block` trace event exists.
        __synthetic: true,
      } as AssistantMessage & { __synthetic: true };
      return { kind: "render-message", name, userMessage, assistantMessage };
    }
  }
}
