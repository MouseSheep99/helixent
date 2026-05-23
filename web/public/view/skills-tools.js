import { chip, escapeAttr, escapeHtml } from "./utils.js";

export function renderSkillsHTML(skills = []) {
  if (!skills.length) return `<div class="empty-state">No skills found.</div>`;
  return skills
    .map(
      (skill) => `
      <div class="list-item skill-item">
        <button class="skill-main" data-skill="${escapeAttr(skill.slug)}">
          <span class="list-item-title"><span>/${escapeHtml(skill.name)}</span>${chip("skill")}</span>
          <span class="list-item-detail">${escapeHtml(skill.description)}</span>
        </button>
        <button class="ghost-button mini-button" data-use-skill="${escapeAttr(skill.name)}">Insert</button>
      </div>`,
    )
    .join("");
}

export function renderToolsHTML(tools = [], query = "") {
  const q = query.toLowerCase();
  const visible = tools.filter((tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q));
  if (!visible.length) return `<div class="empty-state">No tools found.</div>`;
  const groups = groupTools(visible);
  return Object.entries(groups)
    .map(
      ([groupName, groupToolsForName], index) => `
      <details class="tool-group" ${index === 0 ? "open" : ""}>
        <summary>
          <span>${escapeHtml(groupName)}</span>
          <span>${groupToolsForName.length} tools</span>
        </summary>
        ${groupToolsForName.map(renderToolRow).join("")}
      </details>`,
    )
    .join("");
}

function renderToolRow(tool) {
  return `
      <div class="list-item tool-row">
        <label class="tool-toggle">
          <input type="checkbox" data-tool="${escapeAttr(tool.name)}" ${tool.enabled === false ? "" : "checked"} />
          <span>
            <span class="list-item-title">
              <span>${escapeHtml(tool.name)}</span>
              ${tool.requiresApproval ? `<span class="chip warning-chip">approval</span>` : `<span class="chip subtle-chip">enabled</span>`}
            </span>
            <span class="list-item-detail">${escapeHtml(tool.description)}</span>
          </span>
        </label>
        <button class="ghost-button mini-button" data-tool-schema="${escapeAttr(tool.name)}">Schema</button>
      </div>`;
}

function groupTools(tools = []) {
  const groups = {};
  for (const tool of tools) {
    const groupName = toolGroupName(tool.name);
    groups[groupName] ||= [];
    groups[groupName].push(tool);
  }
  return groups;
}

function toolGroupName(name = "") {
  if (["bash"].includes(name)) return "Shell";
  if (["read_file", "write_file", "list_files", "file_info", "mkdir", "move_path"].includes(name)) return "File System";
  if (["grep_search", "glob_search", "str_replace", "apply_patch"].includes(name)) return "Code Intelligence";
  if (name.includes("web") || name.includes("search")) return "Web";
  return "Data";
}

export function renderCommandsHTML(commands = []) {
  return commands
    .map(
      (command) => `
      <option value="/${escapeAttr(command.name)} ">
        ${escapeHtml(command.type)} · ${escapeHtml(command.description)}
      </option>`,
    )
    .join("");
}

export function renderCommandStripHTML(commands = []) {
  const visible = commands.slice(0, 5);
  if (!visible.length) return `<div class="empty-state">No commands loaded.</div>`;
  return `
    <div class="command-strip-items">
      ${visible
        .map(
          (command) => `
          <button class="command-item" type="button" data-command-strip="${escapeAttr(command.name)}">
            <span>/${escapeHtml(command.name)}</span>
            <small>${escapeHtml(command.description || command.type || "")}</small>
          </button>`,
        )
        .join("")}
      <button class="command-item muted" type="button" data-command-strip-more="true">
        <span>More...</span>
        <small>${commands.length} commands</small>
      </button>
    </div>`;
}
