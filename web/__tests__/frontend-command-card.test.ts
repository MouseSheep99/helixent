import { describe, expect, test } from "bun:test";

import {
  buildAgentOutputGraph,
  detectSlashCommandText,
  isAgentOutputRow,
  renderChatThread,
  shouldShowTimelineEvent,
} from "../public/view.js";

const buildGraph = buildAgentOutputGraph as unknown as (rows: any[]) => any;

describe("Command Card graph", () => {
  test("isAgentOutputRow recognises command_executed rows", () => {
    expect(isAgentOutputRow({ type: "command_executed", name: "help" })).toBe(true);
  });

  test("/clear creates empty command card with no assistant blocks", () => {
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/clear" }] } },
      { type: "command_executed", name: "clear", effect: "local", at: "2026-05-25T00:00:00.000Z" },
    ];
    const graph = buildGraph(rows);
    expect(graph.runs).toHaveLength(1);
    const run = graph.runs[0];
    expect(run.commandCards).toHaveLength(1);
    expect(run.commandCards[0].name).toBe("clear");
    expect(run.commandCards[0].assistantBlocks).toEqual([]);
    expect(run.commandCards[0].effect).toBe("local");
  });

  test("/help merges __synthetic assistant text into commandCard.assistantBlocks", () => {
    const helpText = "Available commands:\n/clear\n/help";
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/help" }] } },
      { type: "command_executed", name: "help", effect: "local", at: "2026-05-25T00:00:00.000Z" },
      {
        type: "message",
        message: {
          role: "assistant",
          __synthetic: true,
          content: [{ type: "text", text: helpText }],
        },
      },
    ];
    const graph = buildGraph(rows);
    const run = graph.runs[0];
    expect(run.commandCards).toHaveLength(1);
    const card = run.commandCards[0];
    expect(card.assistantBlocks).toHaveLength(1);
    expect(card.assistantBlocks[0]).toMatchObject({ type: "text", text: helpText });
    // reasoning trail should not pick up the synthetic assistant
    expect(run.steps).toHaveLength(0);
  });

  test("renderChatThread emits chat-command-bubble for slash user message", () => {
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/help" }] } },
      { type: "command_executed", name: "help", effect: "local", at: "2026-05-25T00:00:00.000Z" },
    ];
    const graph = buildGraph(rows);
    const html = renderChatThread(graph);
    expect(html).toContain("chat-command-bubble");
    expect(html).toContain('data-effect="local"');
    expect(html).toContain("/help");
  });

  test("renderChatThread renders command-card with effect chip", () => {
    const rows = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/help" }] } },
      { type: "command_executed", name: "help", effect: "local", at: "2026-05-25T00:00:00.000Z" },
      {
        type: "message",
        message: {
          role: "assistant",
          __synthetic: true,
          content: [{ type: "text", text: "Available commands list" }],
        },
      },
    ];
    const graph = buildGraph(rows);
    const html = renderChatThread(graph);
    expect(html).toContain("command-card");
    expect(html).toContain("command-card-effect-local");
    expect(html).toContain("Available commands list");
  });

  test("detectSlashCommandText extracts the command name", () => {
    expect(detectSlashCommandText("/help")).toEqual({ name: "help", raw: "/help" });
    expect(detectSlashCommandText("  /clear  ")).toEqual({ name: "clear", raw: "/clear" });
    expect(detectSlashCommandText("hello world")).toBeNull();
    expect(detectSlashCommandText("/123")).toBeNull();
  });
});

describe("Timeline slash filter", () => {
  test("shouldShowTimelineEvent('slash') matches command_executed only", () => {
    expect(shouldShowTimelineEvent({ kind: "command_executed", data: { effect: "local" } }, "slash")).toBe(true);
    expect(shouldShowTimelineEvent({ kind: "user_message" }, "slash")).toBe(false);
  });

  test("'slash:local' filters by effect", () => {
    expect(shouldShowTimelineEvent({ kind: "command_executed", data: { effect: "local" } }, "slash:local")).toBe(true);
    expect(shouldShowTimelineEvent({ kind: "command_executed", data: { effect: "prompted" } }, "slash:local")).toBe(false);
  });

  test("'slash:prompted' filters by effect", () => {
    expect(shouldShowTimelineEvent({ kind: "command_executed", data: { effect: "prompted" } }, "slash:prompted")).toBe(true);
    expect(shouldShowTimelineEvent({ kind: "command_executed", data: { effect: "local" } }, "slash:prompted")).toBe(false);
  });
});
