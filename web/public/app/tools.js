// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api } from "./api.js";
import { renderRequest } from "./prompt.js";
import { renderRunState } from "./output.js";

export function renderTools() {
  els.toolList.innerHTML = View.renderToolsHTML(state.tools, els.toolSearch.value);
  els.toolList.querySelectorAll("[data-tool]").forEach((input) => {
    input.addEventListener("change", () => {
      const tool = state.tools.find((item) => item.name === input.dataset.tool);
      if (tool) tool.enabled = input.checked;
    });
  });
  els.toolList.querySelectorAll("[data-tool-schema]").forEach((button) => {
    button.addEventListener("click", () => openToolSchema(button.dataset.toolSchema));
  });
}

export function openToolSchema(name) {
  const tool = state.tools.find((item) => item.name === name);
  if (!tool) return;
  els.toolDialogTitle.textContent = tool.name;
  els.toolDialogDescription.textContent = tool.description || "No tool description available.";
  els.toolDialogSchema.textContent = JSON.stringify(tool.parameters || {}, null, 2);
  els.toolDialogExample.textContent = JSON.stringify(buildToolExample(tool), null, 2);
  els.toolDialog.showModal();
}

export function buildToolExample(tool) {
  const schema = tool?.parameters || {};
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? new Set(schema.required) : null;
  const example = {};

  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (required && !required.has(key) && key !== "description") continue;
    example[key] = exampleValueForSchema(key, fieldSchema);
  }

  if (!Object.keys(example).length) {
    return { description: `Example call for ${tool?.name || "tool"}` };
  }
  return example;
}

export function exampleValueForSchema(key, schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.examples?.length) return schema.examples[0];

  switch (schema.type) {
    case "string":
      if (key === "description") return "Explain why you want to use this tool.";
      if (key === "path") return "/absolute/path/to/target";
      if (key === "pattern") return "**/*.ts";
      if (key === "command") return "echo 'hello world'";
      if (key === "content") return "Example content";
      return `example_${key}`;
    case "integer":
    case "number":
      return schema.minimum ?? schema.exclusiveMinimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return [exampleValueForSchema(`${key}_item`, schema.items || {})];
    case "object":
      return {};
    default:
      return null;
  }
}

export async function applyEnabledTools() {
  if (!state.session) return;
  const tools = (state.tools || []).filter((tool) => tool.enabled !== false).map((tool) => tool.name);
  const snapshot = await api(`/api/sessions/${state.session.sessionId}/tools/enabled`, {
    method: "POST",
    body: { tools },
  });
  state.session = snapshot;
  state.tools = snapshot.tools || [];
  renderTools();
  renderRequest();
  renderRunState();
}
