import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { listSkills } from "@/agent/skills/list-skills";
import { loadAvailableCommands } from "@/cli/tui/command-registry";
import { listProjectSkills } from "../skills";

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

  test("listProjectSkills returns full SkillRecord (slug + content) for editor", async () => {
    const root = await tempSkillsRoot();
    await mkdir(join(root, "skills"), { recursive: true });
    await writeSkill(join(root, "skills"), "handoff", "Handoff skill");

    const records = await listProjectSkills(root);
    const handoff = records.find((s) => s.slug === "handoff");
    expect(handoff).toBeDefined();
    expect(handoff?.name).toBe("handoff");
    expect(handoff?.content).toContain("name: handoff");
    expect(handoff?.content).toContain("# handoff");
    expect(typeof handoff?.path).toBe("string");
  });

  test("listProjectSkills picks up newly added skills (Reload contract)", async () => {
    const root = await tempSkillsRoot();
    await mkdir(join(root, "skills"), { recursive: true });
    await writeSkill(join(root, "skills"), "alpha", "First");

    const before = await listProjectSkills(root);
    expect(before.map((s) => s.slug)).toEqual(["alpha"]);
    expect(before[0]?.content).toBeTruthy();

    await writeSkill(join(root, "skills"), "beta", "Second");

    const after = await listProjectSkills(root);
    expect(after.map((s) => s.slug).sort()).toEqual(["alpha", "beta"]);
    for (const skill of after) {
      expect(skill.content).toBeTruthy();
      expect(skill.slug).toBeTruthy();
    }
  });

  test("listProjectSkills follows symlinked skill directories", async () => {
    const root = await tempSkillsRoot();
    const projectSkills = join(root, "skills");
    const externalSkills = join(root, ".agents", "skills");
    await mkdir(projectSkills, { recursive: true });
    await mkdir(externalSkills, { recursive: true });

    // 真实目录
    await writeSkill(projectSkills, "coding-plan", "Plan coding work");
    // symlink → 外部目录的 skill（模拟 skills/handoff -> ../.agents/skills/handoff）
    await writeSkill(externalSkills, "handoff", "Handoff session");
    await symlink(join(externalSkills, "handoff"), join(projectSkills, "handoff"));

    const records = await listProjectSkills(root);
    const slugs = records.map((s) => s.slug).sort();
    expect(slugs).toEqual(["coding-plan", "handoff"]);

    const handoff = records.find((s) => s.slug === "handoff");
    expect(handoff?.name).toBe("handoff");
    expect(handoff?.content).toContain("# handoff");
  });
});
