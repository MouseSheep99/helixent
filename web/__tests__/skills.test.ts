import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { createProjectSkill, deleteProjectSkill, listProjectSkills, toSkillSlug, updateProjectSkill } from "../skills";

let tempDir: string | undefined;

async function tempProject() {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-web-skills-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("project skills", () => {
  test("creates, lists, updates, and deletes project skills", async () => {
    const cwd = await tempProject();

    const created = await createProjectSkill(
      {
        name: "Prompt Debug",
        description: "Inspect prompts while developing agents.",
      },
      cwd,
    );
    expect(created.slug).toBe("prompt-debug");

    const listed = await listProjectSkills(cwd);
    expect(listed.map((skill) => skill.name)).toEqual(["Prompt Debug"]);

    const updated = await updateProjectSkill(
      "prompt-debug",
      {
        description: "Updated description",
        content: "---\nname: Prompt Debug\ndescription: Updated description\n---\n\n# Updated\n",
      },
      cwd,
    );
    expect(updated.description).toBe("Updated description");
    expect(updated.content).toContain("# Updated");

    await deleteProjectSkill("prompt-debug", cwd);
    expect(await listProjectSkills(cwd)).toEqual([]);
  });

  test("normalizes skill slugs", () => {
    expect(toSkillSlug("Prompt Debug 2")).toBe("prompt-debug-2");
  });
});
