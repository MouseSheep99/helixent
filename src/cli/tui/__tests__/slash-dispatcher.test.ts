import { describe, expect, it } from "bun:test";

import { BUILTIN_COMMANDS, parseSlashInput, type SlashCommand } from "../command-registry";
import { dispatch, type DispatchResult } from "../slash-dispatcher";

const COMMANDS: SlashCommand[] = [
  ...BUILTIN_COMMANDS,
  { name: "skill-creator", description: "Create new skills", type: "skill", effect: "prompted" },
];

function dispatchInput(text: string, context: "cli" | "web"): DispatchResult {
  return dispatch(parseSlashInput(text, COMMANDS), context, COMMANDS);
}

describe("dispatch — not-slash and skill passthrough", () => {
  it("returns noop for plain text", () => {
    expect(dispatchInput("hello", "web")).toEqual({ kind: "noop" });
    expect(dispatchInput("hello", "cli")).toEqual({ kind: "noop" });
  });

  it("returns skill-passthrough for /skill-name", () => {
    expect(dispatchInput("/skill-creator make foo", "web")).toEqual({
      kind: "skill-passthrough",
      skillName: "skill-creator",
      args: "make foo",
    });
  });
});

describe("dispatch — unknown command", () => {
  it("returns unknown-command for /xxx that is not registered", () => {
    expect(dispatchInput("/notacommand", "web")).toEqual({
      kind: "unknown-command",
      name: "notacommand",
      args: "",
    });
    expect(dispatchInput("/notacommand foo", "cli")).toEqual({
      kind: "unknown-command",
      name: "notacommand",
      args: "foo",
    });
  });
});

describe("dispatch — /clear", () => {
  it("emits clear-agent-messages + clear-todos + clear-trace mutations on web", () => {
    const result = dispatchInput("/clear", "web");
    expect(result.kind).toBe("state-mutation");
    if (result.kind === "state-mutation") {
      expect(result.name).toBe("clear");
      expect(result.mutations.map((m) => m.kind)).toEqual([
        "clear-agent-messages",
        "clear-todos",
        "clear-trace",
      ]);
      expect(result.userMessage.content[0]).toEqual({ type: "text", text: "/clear" });
    }
  });

  it("emits the same mutations on cli", () => {
    const result = dispatchInput("/clear", "cli");
    expect(result.kind).toBe("state-mutation");
  });
});

describe("dispatch — /help", () => {
  it("returns render-message with both user and assistant messages", () => {
    const result = dispatchInput("/help", "web");
    expect(result.kind).toBe("render-message");
    if (result.kind === "render-message") {
      expect(result.name).toBe("help");
      expect(result.userMessage.content[0]).toEqual({ type: "text", text: "/help" });
      expect(result.assistantMessage.role).toBe("assistant");
      const text = (result.assistantMessage.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("/clear");
      expect(text).toContain("/skill-creator");
    }
  });

  it("supports /help <name> with details", () => {
    const result = dispatchInput("/help clear", "cli");
    if (result.kind !== "render-message") throw new Error("expected render-message");
    const text = (result.assistantMessage.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("/clear");
    expect(text).toContain("Built-in command");
  });
});

describe("dispatch — /exit and /quit availability", () => {
  it("is unsupported on web with cli-only reason", () => {
    expect(dispatchInput("/exit", "web")).toEqual({
      kind: "unsupported",
      name: "exit",
      reason: "cli-only",
    });
    expect(dispatchInput("/quit", "web")).toEqual({
      kind: "unsupported",
      name: "quit",
      reason: "cli-only",
    });
  });

  it("triggers exit-process on cli", () => {
    const result = dispatchInput("/exit", "cli");
    expect(result.kind).toBe("state-mutation");
    if (result.kind === "state-mutation") {
      expect(result.name).toBe("exit");
      expect(result.mutations).toEqual([{ kind: "exit-process" }]);
    }
  });
});
