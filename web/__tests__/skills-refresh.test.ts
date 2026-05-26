import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { listSkills } from "@/agent/skills/list-skills";
import { loadAvailableCommands } from "@/cli/tui/command-registry";

let tempDir: string | undefined;

async function tempSkillsRoot() {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-skills-refresh-"));
  return tempDir;
}

async function writeSkill(skillsDir: string, name: string, description: string) {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("skills hot-reload (refreshSingleSession behavior)", () => {
  test("re-running listSkills picks up newly added skill files on disk", async () => {
    const root = await tempSkillsRoot();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "alpha", "First skill");

    const before = await listSkills([skillsDir]);
    expect(before.map((s) => s.name).sort()).toEqual(["alpha"]);

    await writeSkill(skillsDir, "beta", "Second skill");

    const after = await listSkills([skillsDir]);
    expect(after.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("re-running loadAvailableCommands surfaces new skill commands", async () => {
    const root = await tempSkillsRoot();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "alpha", "First skill");

    const before = await loadAvailableCommands([skillsDir]);
    expect(before.some((cmd) => cmd.name === "alpha")).toBe(true);
    expect(before.some((cmd) => cmd.name === "beta")).toBe(false);

    await writeSkill(skillsDir, "beta", "Second skill");

    const after = await loadAvailableCommands([skillsDir]);
    expect(after.some((cmd) => cmd.name === "alpha")).toBe(true);
    expect(after.some((cmd) => cmd.name === "beta")).toBe(true);
  });

  test("removing a skill on disk drops it on next refresh", async () => {
    const root = await tempSkillsRoot();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "alpha", "First skill");
    await writeSkill(skillsDir, "beta", "Second skill");

    const before = await loadAvailableCommands([skillsDir]);
    expect(before.some((cmd) => cmd.name === "beta")).toBe(true);

    await rm(join(skillsDir, "beta"), { recursive: true, force: true });

    const after = await loadAvailableCommands([skillsDir]);
    expect(after.some((cmd) => cmd.name === "beta")).toBe(false);
    expect(after.some((cmd) => cmd.name === "alpha")).toBe(true);
  });

  test("built-in commands always appear alongside skill commands", async () => {
    const root = await tempSkillsRoot();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });

    const empty = await loadAvailableCommands([skillsDir]);
    const builtinNames = empty.map((cmd) => cmd.name);
    expect(builtinNames).toContain("help");
    expect(builtinNames).toContain("clear");

    await writeSkill(skillsDir, "alpha", "First skill");

    const withSkill = await loadAvailableCommands([skillsDir]);
    expect(withSkill.some((cmd) => cmd.name === "help")).toBe(true);
    expect(withSkill.some((cmd) => cmd.name === "alpha")).toBe(true);
  });

  test("skill commands carry effect: 'prompted' so the front-end shows the right chip", async () => {
    const root = await tempSkillsRoot();
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "alpha", "First skill");

    const commands = await loadAvailableCommands([skillsDir]);
    const alpha = commands.find((cmd) => cmd.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.effect).toBe("prompted");

    const help = commands.find((cmd) => cmd.name === "help");
    expect(help?.effect).toBe("local");
  });
});
