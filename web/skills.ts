import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import matter from "gray-matter";

import type { SaveSkillBody, SkillRecord, UpdateSkillBody } from "./types";

export function getProjectSkillsDir(cwd = process.cwd()) {
  return join(cwd, "skills");
}

export async function listProjectSkills(cwd = process.cwd()): Promise<SkillRecord[]> {
  const skillsDir = getProjectSkillsDir(cwd);
  await mkdir(skillsDir, { recursive: true });
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    try {
      const content = await readFile(skillFile, "utf8");
      const parsed = matter(content);
      if (typeof parsed.data.name !== "string" || typeof parsed.data.description !== "string") {
        continue;
      }
      skills.push({
        name: parsed.data.name,
        description: parsed.data.description,
        path: skillFile,
        slug: entry.name,
        content,
      });
    } catch {
      continue;
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createProjectSkill(body: SaveSkillBody, cwd = process.cwd()): Promise<SkillRecord> {
  const name = body.name.trim();
  const description = body.description.trim();
  if (!name || !description) {
    throw new Error("Skill name and description are required.");
  }

  const slug = toSkillSlug(name);
  const skillDir = join(getProjectSkillsDir(cwd), slug);
  await mkdir(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  const content = body.content?.trim()
    ? normalizeSkillContent(body.content, name, description)
    : buildSkillMarkdown({ name, description });
  await writeFile(path, content, "utf8");
  return { name, description, slug, path, content };
}

export async function updateProjectSkill(slug: string, body: UpdateSkillBody, cwd = process.cwd()): Promise<SkillRecord> {
  const safeSlug = toSkillSlug(slug);
  const existingPath = join(getProjectSkillsDir(cwd), safeSlug, "SKILL.md");
  const current = await readFile(existingPath, "utf8");
  const currentParsed = matter(current);
  const nextName = body.name?.trim() || (typeof currentParsed.data.name === "string" ? currentParsed.data.name : safeSlug);
  const nextDescription =
    body.description?.trim() ||
    (typeof currentParsed.data.description === "string" ? currentParsed.data.description : "Project skill");
  const content = normalizeSkillContent(body.content, nextName, nextDescription);
  await writeFile(existingPath, content, "utf8");
  return {
    name: nextName,
    description: nextDescription,
    slug: safeSlug,
    path: existingPath,
    content,
  };
}

export async function deleteProjectSkill(slug: string, cwd = process.cwd()) {
  const safeSlug = toSkillSlug(slug);
  await rm(join(getProjectSkillsDir(cwd), safeSlug), { recursive: true, force: true });
}

export function toSkillSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Skill name must contain at least one alphanumeric character.");
  }
  return slug;
}

function normalizeSkillContent(content: string, name: string, description: string) {
  const parsed = matter(content);
  const body = parsed.content.trim() || `# ${name}\n\nDescribe the workflow here.`;
  return matter.stringify(body + "\n", {
    ...parsed.data,
    name,
    description,
  });
}

function buildSkillMarkdown({ name, description }: { name: string; description: string }) {
  return matter.stringify(`# ${name}\n\nDescribe the workflow here.\n`, {
    name,
    description,
  });
}
