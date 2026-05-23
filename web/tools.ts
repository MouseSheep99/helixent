import { createTodoSystem } from "@/agent/todos";
import { CODING_TOOLS_REQUIRING_APPROVAL } from "@/coding/permissions";
import { askUserQuestionParametersSchema } from "@/coding/tools/ask-user-question";
import { applyPatchTool } from "@/coding/tools/apply-patch";
import { bashTool } from "@/coding/tools/bash";
import { fileInfoTool } from "@/coding/tools/file-info";
import { globSearchTool } from "@/coding/tools/glob-search";
import { grepSearchTool } from "@/coding/tools/grep-search";
import { listFilesTool } from "@/coding/tools/list-files";
import { mkdirTool } from "@/coding/tools/mkdir";
import { movePathTool } from "@/coding/tools/move-path";
import { readFileTool } from "@/coding/tools/read-file";
import { strReplaceTool } from "@/coding/tools/str-replace";
import { writeFileTool } from "@/coding/tools/write-file";
import type { Tool } from "@/foundation";

import type { ToolInventoryItem } from "./types";

export function getDefaultToolInventory(enabledTools?: Set<string>): ToolInventoryItem[] {
  const { tool: todoTool } = createTodoSystem();
  const tools: Tool[] = [
    bashTool,
    fileInfoTool,
    listFilesTool,
    globSearchTool,
    grepSearchTool,
    mkdirTool,
    movePathTool,
    readFileTool,
    writeFileTool,
    strReplaceTool,
    applyPatchTool,
    todoTool,
    {
      name: "ask_user_question",
      description:
        "Ask the user one or more independent questions with fixed choices. Prefer this over free-form questions when options are clear.",
      parameters: askUserQuestionParametersSchema,
      invoke: async () => ({ answers: [] }),
    },
  ];
  return toToolInventory(tools, enabledTools);
}

export function toToolInventory(tools?: Tool[], enabledTools?: Set<string>): ToolInventoryItem[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters.toJSONSchema(),
    requiresApproval: CODING_TOOLS_REQUIRING_APPROVAL.includes(tool.name),
    ...(enabledTools ? { enabled: enabledTools.has(tool.name) } : {}),
  }));
}

export function filterTools(tools: Tool[] | undefined, enabledTools: Set<string>): Tool[] | undefined {
  if (!tools) return tools;
  return tools.filter((tool) => enabledTools.has(tool.name));
}

export function defaultEnabledToolNames() {
  return getDefaultToolInventory().map((tool) => tool.name);
}
