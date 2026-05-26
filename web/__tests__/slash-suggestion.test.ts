import { describe, expect, it } from "bun:test";

import { computeSuggestionState } from "../public/view/slash-suggestion.js";
import { renderSuggestionPopoverHTML } from "../public/view/render-suggestion.js";
import { renderCommandChipHTML } from "../public/view/command-chip.js";

const COMMANDS = [
  { name: "clear", description: "Clear the current conversation history", type: "builtin", effect: "local" },
  { name: "help", description: "List available slash commands", type: "builtin", effect: "local" },
  { name: "handoff", description: "Compact the conversation", type: "skill", effect: "prompted" },
  { name: "to-prd", description: "Turn context into a PRD", type: "skill", effect: "prompted" },
];

describe("computeSuggestionState", () => {
  it("returns open=false when text does not start with a slash on the current line", () => {
    expect(
      computeSuggestionState({ text: "hello world", caretOffset: 11, commands: COMMANDS }),
    ).toEqual({ open: false, query: "", items: [], activeIndex: 0 });
    expect(
      computeSuggestionState({ text: "", caretOffset: 0, commands: COMMANDS }),
    ).toEqual({ open: false, query: "", items: [], activeIndex: 0 });
  });

  it("opens with empty query and full command list when only `/` was typed", () => {
    const result = computeSuggestionState({ text: "/", caretOffset: 1, commands: COMMANDS });
    expect(result.open).toBe(true);
    expect(result.query).toBe("");
    expect(result.items.length).toBe(COMMANDS.length);
    expect(result.activeIndex).toBe(0);
  });

  it("ranks prefix matches above substring matches and highlights the query span", () => {
    const result = computeSuggestionState({ text: "/he", caretOffset: 3, commands: COMMANDS });
    expect(result.open).toBe(true);
    expect(result.query).toBe("he");
    // 只有 help 是 name 前缀命中（score 3）；clear/handoff 命中 description「the」（score 1）。
    expect(result.items[0]!.name).toBe("help");
    expect(result.items[0]!.matchHighlight).toEqual([[0, 2]]);
  });

  it("closes once a whitespace appears in the slash token (already typing args)", () => {
    expect(
      computeSuggestionState({ text: "/help foo", caretOffset: 9, commands: COMMANDS }).open,
    ).toBe(false);
  });

  it("opens when the slash starts a new line in a multi-line buffer", () => {
    const result = computeSuggestionState({
      text: "first line\n/he",
      caretOffset: 14,
      commands: COMMANDS,
    });
    expect(result.open).toBe(true);
    expect(result.query).toBe("he");
  });

  it("closes when the caret moves out of the slash token even if `/` is still in the text", () => {
    const result = computeSuggestionState({
      text: "hello /he",
      caretOffset: 5,
      commands: COMMANDS,
    });
    expect(result.open).toBe(false);
  });

  it("matches case-insensitively", () => {
    const upperCommands = COMMANDS.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    const result = computeSuggestionState({ text: "/he", caretOffset: 3, commands: upperCommands });
    expect(result.open).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("returns open=true with empty items when commands list is empty", () => {
    const result = computeSuggestionState({ text: "/foo", caretOffset: 4, commands: [] });
    expect(result.open).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.activeIndex).toBe(0);
  });

  it("clamps activeIndex to a valid range", () => {
    const result = computeSuggestionState({
      text: "/",
      caretOffset: 1,
      commands: COMMANDS,
      activeIndex: 99,
    });
    expect(result.activeIndex).toBe(COMMANDS.length - 1);
  });
});

describe("renderSuggestionPopoverHTML", () => {
  it("returns empty string when not open", () => {
    expect(renderSuggestionPopoverHTML({ open: false, items: [], activeIndex: 0 })).toBe("");
  });

  it("renders a no-commands placeholder when items array is empty but open", () => {
    const html = renderSuggestionPopoverHTML({ open: true, items: [], activeIndex: 0 });
    expect(html).toContain("No commands available");
    expect(html).toContain('role="listbox"');
  });

  it("marks the active item with aria-selected=true and active class", () => {
    const state = computeSuggestionState({ text: "/", caretOffset: 1, commands: COMMANDS });
    const html = renderSuggestionPopoverHTML(state);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("slash-popover-item active");
  });

  it("includes <mark> highlight when matchHighlight is set", () => {
    const state = computeSuggestionState({ text: "/he", caretOffset: 3, commands: COMMANDS });
    const html = renderSuggestionPopoverHTML(state);
    expect(html).toContain("<mark>he</mark>");
  });

  it("renders both Built-in and Skills section headers when both are present", () => {
    const state = computeSuggestionState({ text: "/", caretOffset: 1, commands: COMMANDS });
    const html = renderSuggestionPopoverHTML(state);
    expect(html).toContain("Built-in");
    expect(html).toContain("Skills");
  });
});

describe("renderCommandChipHTML", () => {
  it("returns empty string for not-slash", () => {
    expect(renderCommandChipHTML({ kind: "not-slash" })).toBe("");
    expect(renderCommandChipHTML(null)).toBe("");
  });

  it("renders a local chip for builtin/clear", () => {
    const html = renderCommandChipHTML({ kind: "builtin", name: "clear", effect: "local" });
    expect(html).toContain("composer-chip-builtin");
    expect(html).toContain("composer-chip-effect-local");
    expect(html).toContain("Local");
  });

  it("renders a prompted chip for skill", () => {
    const html = renderCommandChipHTML({ kind: "skill", name: "to-prd" });
    expect(html).toContain("composer-chip-skill");
    expect(html).toContain("composer-chip-effect-prompted");
    expect(html).toContain("Sent to model · skill");
  });

  it("renders an unknown chip for unknown command", () => {
    const html = renderCommandChipHTML({ kind: "unknown", name: "nope" });
    expect(html).toContain("composer-chip-unknown");
    expect(html).toContain("composer-chip-effect-unknown");
    expect(html).toContain("Unknown");
  });
});
