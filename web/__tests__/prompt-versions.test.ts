import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createPromptVersionRecord,
  deletePromptVersion,
  getActivePromptVersion,
  loadPromptState,
  savePromptState,
  setActivePromptVersion,
  upsertPromptVersion,
} from "../prompt-versions";

let tempDir: string | undefined;

async function tempBaseDir() {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-web-prompt-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("prompt version persistence", () => {
  test("saves, loads, activates, and deletes prompt versions", async () => {
    const baseDir = await tempBaseDir();
    const runtimeSnapshot = {
      source: "runtime" as const,
      prompt: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "bash", description: "Run shell", parameters: {}, requiresApproval: true }],
      requestedSkillName: "coding-plan",
    } as any;
    const version = createPromptVersionRecord(runtimeSnapshot, "v1");
    let state = upsertPromptVersion(await loadPromptState("session-1", baseDir), version);
    state = { ...state, runtime: runtimeSnapshot };

    await savePromptState("session-1", state, baseDir);
    const loaded = await loadPromptState("session-1", baseDir);
    const savedVersion = loaded.versions[0]!;

    expect(loaded.versions).toHaveLength(1);
    expect(savedVersion.name).toBe("v1");
    expect(loaded.runtime?.prompt).toBe("system prompt");

    const activated = setActivePromptVersion(loaded, savedVersion.id);
    expect(getActivePromptVersion(activated)?.name).toBe("v1");

    const deleted = deletePromptVersion(activated, savedVersion.id);
    expect(deleted.versions).toHaveLength(0);
    expect(deleted.activeVersionId).toBeNull();
  });
});
