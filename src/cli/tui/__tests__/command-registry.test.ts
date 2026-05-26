import { describe, expect, it } from "bun:test";

import {
  BUILTIN_COMMANDS,
  formatHelp,
  isCommandAvailableOn,
  parseSlashInput,
  resolveBuiltinCommand,
  type SlashCommand,
} from "../command-registry";

describe("resolveBuiltinCommand", () => {
  it("resolves a bare builtin", () => {
    expect(resolveBuiltinCommand("/clear")).toEqual({ name: "clear", args: "" });
    expect(resolveBuiltinCommand("/exit")).toEqual({ name: "exit", args: "" });
    expect(resolveBuiltinCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("captures trailing args after a builtin", () => {
    expect(resolveBuiltinCommand("/help clear")).toEqual({ name: "help", args: "clear" });
    expect(resolveBuiltinCommand("/help   skill-creator")).toEqual({
      name: "help",
      args: "skill-creator",
    });
  });

  it("treats input with no leading slash the same way", () => {
    expect(resolveBuiltinCommand("clear")).toEqual({ name: "clear", args: "" });
  });

  it("returns null for unknown commands and empty input", () => {
    expect(resolveBuiltinCommand("/nope")).toBeNull();
    expect(resolveBuiltinCommand("")).toBeNull();
    expect(resolveBuiltinCommand("   ")).toBeNull();
  });
});

describe("formatHelp", () => {
  const commands: SlashCommand[] = [
    ...BUILTIN_COMMANDS,
    { name: "skill-creator", description: "Create new skills", type: "skill", effect: "prompted" },
  ];

  it("lists builtins and skills when called with no target", () => {
    const text = formatHelp(commands);
    expect(text).toContain("Available slash commands");
    expect(text).toContain("/clear");
    expect(text).toContain("/help");
    expect(text).toContain("/skill-creator");
    expect(text).toContain("Create new skills");
  });

  it("renders details for a single command", () => {
    const text = formatHelp(commands, "clear");
    expect(text).toContain("/clear");
    expect(text).toContain("Built-in command");
    expect(text).toContain("Clear the current conversation history");
  });

  it("tolerates a leading slash and case in target", () => {
    const text = formatHelp(commands, "/CLEAR");
    expect(text).toContain("/clear");
  });

  it("returns an error message for unknown targets", () => {
    const text = formatHelp(commands, "nope");
    expect(text).toContain("Unknown command");
    expect(text).toContain("/nope");
  });
});

describe("parseSlashInput", () => {
  const commands: SlashCommand[] = [
    ...BUILTIN_COMMANDS,
    { name: "skill-creator", description: "Create new skills", type: "skill", effect: "prompted" },
  ];

  it("treats input without a leading slash as not-slash", () => {
    expect(parseSlashInput("hello world", commands)).toEqual({ kind: "not-slash" });
    expect(parseSlashInput("clear", commands)).toEqual({ kind: "not-slash" });
    expect(parseSlashInput("", commands)).toEqual({ kind: "not-slash" });
    expect(parseSlashInput("   ", commands)).toEqual({ kind: "not-slash" });
  });

  it("resolves builtins with optional args", () => {
    expect(parseSlashInput("/clear", commands)).toEqual({ kind: "builtin", name: "clear", args: "" });
    expect(parseSlashInput("/help clear", commands)).toEqual({ kind: "builtin", name: "help", args: "clear" });
    expect(parseSlashInput("/exit", commands)).toEqual({ kind: "builtin", name: "exit", args: "" });
  });

  it("resolves skills when present in the commands list", () => {
    expect(parseSlashInput("/skill-creator make foo", commands)).toEqual({
      kind: "skill",
      name: "skill-creator",
      args: "make foo",
    });
  });

  it("returns unknown for /xxx that does not match any command", () => {
    expect(parseSlashInput("/notacommand", commands)).toEqual({
      kind: "unknown",
      raw: "notacommand",
      args: "",
    });
    expect(parseSlashInput("/notacommand foo", commands)).toEqual({
      kind: "unknown",
      raw: "notacommand",
      args: "foo",
    });
  });

  it("falls back to unknown for /skill-name when commands list is omitted", () => {
    expect(parseSlashInput("/skill-creator make foo")).toEqual({
      kind: "unknown",
      raw: "skill-creator",
      args: "make foo",
    });
  });
});

describe("availability metadata", () => {
  it("marks exit/quit as cli-only and clear/help as cli+web", () => {
    const exit = BUILTIN_COMMANDS.find((c) => c.name === "exit")!;
    const quit = BUILTIN_COMMANDS.find((c) => c.name === "quit")!;
    const clear = BUILTIN_COMMANDS.find((c) => c.name === "clear")!;
    const help = BUILTIN_COMMANDS.find((c) => c.name === "help")!;

    expect(isCommandAvailableOn(exit, "cli")).toBe(true);
    expect(isCommandAvailableOn(exit, "web")).toBe(false);
    expect(isCommandAvailableOn(quit, "web")).toBe(false);
    expect(isCommandAvailableOn(clear, "web")).toBe(true);
    expect(isCommandAvailableOn(help, "web")).toBe(true);
  });

  it("treats commands without availability as available everywhere", () => {
    const skill: SlashCommand = { name: "anywhere", description: "x", type: "skill", effect: "prompted" };
    expect(isCommandAvailableOn(skill, "cli")).toBe(true);
    expect(isCommandAvailableOn(skill, "web")).toBe(true);
  });
});

describe("effect metadata", () => {
  it("marks every BUILTIN_COMMANDS entry as local", () => {
    for (const command of BUILTIN_COMMANDS) {
      expect(command.effect).toBe("local");
    }
  });

  it("requires effect on every SlashCommand (compile-time + runtime)", () => {
    // 编译时由 TS 类型保证；这里再做一次运行时断言防止有人通过 any 旁路。
    for (const command of BUILTIN_COMMANDS) {
      expect(typeof command.effect).toBe("string");
      expect(["local", "prompted"]).toContain(command.effect);
    }
  });

  it("formatHelp footer mentions skill reload behaviour", () => {
    const text = formatHelp(BUILTIN_COMMANDS);
    expect(text).toContain("Skills are loaded on session start");
    expect(text).toContain("Reload");
  });
});
