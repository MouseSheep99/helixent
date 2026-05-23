import { describe, expect, test } from "bun:test";

import { defaultEnabledToolNames, filterTools, getDefaultToolInventory } from "../tools";

describe("web tool inventory", () => {
  test("lists default tools with approval metadata", () => {
    const tools = getDefaultToolInventory(new Set(defaultEnabledToolNames()));
    const bash = tools.find((tool) => tool.name === "bash");
    const readFile = tools.find((tool) => tool.name === "read_file");

    expect(bash?.requiresApproval).toBe(true);
    expect(bash?.enabled).toBe(true);
    expect(readFile?.requiresApproval).toBe(false);
  });

  test("filters tools by enabled set", () => {
    const tools = [
      { name: "a", description: "A", parameters: { toJSONSchema: () => ({}) }, invoke: async () => "a" },
      { name: "b", description: "B", parameters: { toJSONSchema: () => ({}) }, invoke: async () => "b" },
    ] as any;

    expect(filterTools(tools, new Set(["b"]))?.map((tool) => tool.name)).toEqual(["b"]);
  });
});
