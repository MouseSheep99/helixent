import { listSkills } from "@/agent/skills/list-skills";
import type { SkillFrontmatter } from "@/agent/skills/types";

/** Where a slash command is allowed to run. */
export type SlashCommandSurface = "cli" | "web";

export interface SlashCommand {
  name: string;
  description: string;
  type: "builtin" | "skill";
  /**
   * Whether this command's user/assistant turn participates in subsequent model
   * context.
   *
   * - `local`: dispatcher handles it server-side and never appends to
   *   `session.agent.messages`. Examples: `/clear`, `/help`, `/exit`.
   * - `prompted`: the input flows through `agent.stream(userMessage)` and is
   *   visible to the model in later turns. All skills default to this.
   *
   * Required so any new builtin must explicitly choose its semantics.
   */
  effect: "local" | "prompted";
  /**
   * Surfaces where this command is supported. Defaults to ["cli","web"] when omitted.
   * Use to mark TUI-only commands (e.g. exit/quit) so the web surface can give a
   * clear "unsupported" reply instead of silently no-oping.
   */
  availability?: ReadonlyArray<SlashCommandSurface>;
  /** Optional long-form help text used by `formatHelp(_, name)`. Falls back to `description`. */
  helpDetails?: string;
}

export interface PromptSubmission {
  text: string;
  requestedSkillName: string | null;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "clear",
    description: "Clear the current conversation history",
    type: "builtin",
    effect: "local",
    availability: ["cli", "web"],
  },
  {
    name: "exit",
    description: "Exit the TUI session",
    type: "builtin",
    effect: "local",
    availability: ["cli"],
  },
  {
    name: "help",
    description: "List available slash commands, or show details for one (`/help <name>`)",
    type: "builtin",
    effect: "local",
    availability: ["cli", "web"],
  },
  {
    name: "quit",
    description: "Exit the TUI session",
    type: "builtin",
    effect: "local",
    availability: ["cli"],
  },
];

/** Parsed builtin invocation: command name plus any trailing argument string. */
export interface BuiltinInvocation {
  name: SlashCommand["name"];
  args: string;
}

/**
 * Builtin command names. Constrained as a string literal union for downstream
 * exhaustive switches (e.g. dispatcher).
 */
export type BuiltinCommandName = "clear" | "exit" | "help" | "quit";

/**
 * Result of parsing a single line of textarea / TUI input into a slash-command intent.
 *
 * - `not-slash`: the input is a regular user message (no leading `/`). Callers should
 *   forward to the model.
 * - `builtin` / `skill`: the input matched a registered command.
 * - `unknown`: the input *looks* like `/xxx` but no registered command matched. Callers
 *   should typically warn the user before sending the literal text to the model.
 */
export type SlashParseResult =
  | { kind: "not-slash" }
  | { kind: "builtin"; name: BuiltinCommandName; args: string }
  | { kind: "skill"; name: string; args: string }
  | { kind: "unknown"; raw: string; args: string };

export async function loadAvailableCommands(skillsDirs?: string[]): Promise<SlashCommand[]> {
  const skills = await listSkills(skillsDirs);
  const skillCommands = skills.map(toSkillCommand).sort((left, right) => left.name.localeCompare(right.name));
  return dedupeCommands([...BUILTIN_COMMANDS, ...skillCommands]);
}

export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const normalizedFilter = normalizeCommandName(filter);
  if (!normalizedFilter) return commands;

  return commands
    .filter((command) => {
      const name = command.name.toLowerCase();
      const description = command.description.toLowerCase();
      return name.includes(normalizedFilter) || description.includes(normalizedFilter);
    })
    .sort((left, right) => scoreCommandMatch(right, normalizedFilter) - scoreCommandMatch(left, normalizedFilter));
}

export function getSlashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  if (/\s/.test(text)) return null;
  return text.slice(1);
}

export function insertSlashCommand(command: SlashCommand): string {
  return `/${command.name} `;
}

export function getHighlightedCommandName(text: string, commands: SlashCommand[]): string | null {
  const match = text.match(/^\/([^\s]+)\s/);
  if (!match) return null;
  const commandToken = match[1];
  if (!commandToken) return null;

  const commandName = normalizeCommandName(commandToken);
  return commands.some((command) => command.name.toLowerCase() === commandName) ? commandToken : null;
}

export function resolveBuiltinCommand(text: string): BuiltinInvocation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^\/?([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const token = match[1];
  if (!token) return null;

  const normalized = normalizeCommandName(token);
  const builtin = BUILTIN_COMMANDS.find((command) => command.name === normalized);
  if (!builtin) return null;

  return { name: builtin.name, args: (match[2] ?? "").trim() };
}

/**
 * Unified parser for slash input. Strict about the leading `/`: only inputs that
 * start with `/` can become `builtin` / `skill` / `unknown`. Bare words like
 * `clear` are treated as `not-slash` so they are never silently rerouted.
 *
 * Pass the merged commands list (builtin + skills) to enable `skill` resolution;
 * omit it to only resolve builtins (everything else becomes `unknown` if it has
 * a leading `/`).
 */
export function parseSlashInput(text: string, commands?: ReadonlyArray<SlashCommand>): SlashParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "not-slash" };

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: "not-slash" };
  const token = match[1];
  if (!token) return { kind: "not-slash" };

  const normalized = normalizeCommandName(token);
  const args = (match[2] ?? "").trim();

  const builtin = BUILTIN_COMMANDS.find((command) => command.name === normalized);
  if (builtin) {
    return { kind: "builtin", name: builtin.name as BuiltinCommandName, args };
  }

  const skill = commands?.find(
    (command) => command.type === "skill" && command.name.toLowerCase() === normalized,
  );
  if (skill) {
    return { kind: "skill", name: skill.name, args };
  }

  return { kind: "unknown", raw: normalized, args };
}

/** Returns true when the command may run on the requested surface. Missing availability defaults to "all surfaces". */
export function isCommandAvailableOn(command: SlashCommand, surface: SlashCommandSurface): boolean {
  if (!command.availability) return true;
  return command.availability.includes(surface);
}

/**
 * Renders a help string for slash commands. With no `target`, lists all
 * commands grouped by type. With a `target`, prints the matched command's
 * details, or an error message if not found.
 */
export function formatHelp(commands: SlashCommand[], target?: string): string {
  if (target) {
    const normalized = normalizeCommandName(target);
    const match = commands.find((c) => c.name.toLowerCase() === normalized);
    if (!match) {
      return `Unknown command: \`/${target}\`. Run \`/help\` to see available commands.`;
    }
    const kind = match.type === "builtin" ? "Built-in command" : "Skill";
    const body = match.helpDetails ?? match.description;
    return `**/${match.name}** — _${kind}_\n\n${body}`;
  }

  const builtins = commands.filter((c) => c.type === "builtin");
  const skills = commands.filter((c) => c.type === "skill");

  const lines: string[] = ["**Available slash commands**", ""];

  if (builtins.length > 0) {
    lines.push("_Built-in_");
    for (const c of builtins) {
      lines.push(`- \`/${c.name}\` — ${c.description}`);
    }
  }

  if (skills.length > 0) {
    if (builtins.length > 0) lines.push("");
    lines.push("_Skills_");
    for (const c of skills) {
      lines.push(`- \`/${c.name}\` — ${c.description}`);
    }
  }

  lines.push(
    "",
    "Run `/help <name>` for details on a single command.",
    "Skills are loaded on session start, page refresh, or via the Skills > Reload button.",
  );
  return lines.join("\n");
}

export function buildPromptSubmission(text: string, commands: SlashCommand[]): PromptSubmission {
  const match = text.match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) {
    return {
      text,
      requestedSkillName: null,
    };
  }
  const commandToken = match[1];
  if (!commandToken) {
    return {
      text,
      requestedSkillName: null,
    };
  }

  const requestedSkill = commands.find(
    (command) => command.type === "skill" && command.name.toLowerCase() === normalizeCommandName(commandToken),
  );

  return {
    text,
    requestedSkillName: requestedSkill?.name ?? null,
  };
}

function toSkillCommand(skill: SkillFrontmatter): SlashCommand {
  return {
    name: skill.name,
    description: skill.description,
    type: "skill",
    effect: "prompted",
  };
}

function dedupeCommands(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  const deduped: SlashCommand[] = [];

  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(command);
  }

  return deduped;
}

function normalizeCommandName(value: string): string {
  return value.replace(/^\//, "").trim().toLowerCase();
}

function scoreCommandMatch(command: SlashCommand, filter: string): number {
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();

  if (name.startsWith(filter)) return 3;
  if (name.includes(filter)) return 2;
  if (description.includes(filter)) return 1;
  return 0;
}
