import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getHelixentHomePath } from "@/cli/config";

import type { PromptSnapshot, PromptState, PromptVersionRecord } from "./types";

const DEFAULT_PROMPT_STATE: PromptState = {
  activeVersionId: null,
  runtime: null,
  versions: [],
  draftPrompt: null,
  draftUpdatedAt: null,
};

export function getPromptVersionsDir(baseDir = getHelixentHomePath()) {
  return join(baseDir, "prompt-versions");
}

export function getPromptStatePath(sessionId: string, baseDir = getHelixentHomePath()) {
  return join(getPromptVersionsDir(baseDir), `${safeSessionId(sessionId)}.json`);
}

export async function loadPromptState(sessionId: string, baseDir = getHelixentHomePath()): Promise<PromptState> {
  const path = getPromptStatePath(sessionId, baseDir);
  try {
    const raw = await readFile(path, "utf8");
    return normalizePromptState(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) return cloneDefaultPromptState();
    return cloneDefaultPromptState();
  }
}

export async function savePromptState(sessionId: string, state: PromptState, baseDir = getHelixentHomePath()) {
  const path = getPromptStatePath(sessionId, baseDir);
  await mkdir(dirname(path), { recursive: true });
  const normalized = normalizePromptState(state);
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
  return normalized;
}

export function cloneDefaultPromptState(): PromptState {
  return structuredClone(DEFAULT_PROMPT_STATE);
}

export function createPromptVersionRecord(snapshot: PromptSnapshot, name: string): PromptVersionRecord {
  const now = new Date().toISOString();
  const version: PromptVersionRecord = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...normalizePromptSnapshot(snapshot),
    source: "prompt_version",
    name,
    versionId: null,
  };
  return version;
}

export function normalizePromptSnapshot(snapshot: Partial<PromptSnapshot> | null | undefined): PromptSnapshot {
  const source = snapshot?.source === "prompt_version" || snapshot?.source === "draft" ? snapshot.source : "runtime";
  return {
    source,
    versionId: snapshot?.versionId ?? null,
    name: snapshot?.name ?? null,
    prompt: typeof snapshot?.prompt === "string" ? snapshot.prompt : "",
    messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
    tools: Array.isArray(snapshot?.tools) ? snapshot.tools : [],
    requestedSkillName: snapshot?.requestedSkillName ?? null,
  };
}

export function normalizePromptState(raw: unknown): PromptState {
  if (!raw || typeof raw !== "object") return cloneDefaultPromptState();
  const input = raw as Partial<PromptState>;
  const versions = Array.isArray(input.versions)
    ? input.versions.map((version) => normalizePromptVersion(version))
    : [];
  const activeVersionId = typeof input.activeVersionId === "string" ? input.activeVersionId : null;
  const runtime = input.runtime ? normalizePromptSnapshot(input.runtime) : null;
  const draftPrompt = typeof input.draftPrompt === "string" ? input.draftPrompt : null;
  const draftUpdatedAt = typeof input.draftUpdatedAt === "string" ? input.draftUpdatedAt : null;
  return { activeVersionId, runtime, versions, draftPrompt, draftUpdatedAt };
}

export function setPromptDraft(state: PromptState, draftPrompt: string | null): PromptState {
  const nextDraftPrompt = typeof draftPrompt === "string" ? draftPrompt : null;
  return { ...state, draftPrompt: nextDraftPrompt, draftUpdatedAt: nextDraftPrompt === null ? null : new Date().toISOString() };
}

export function getActivePromptVersion(state: PromptState): PromptVersionRecord | null {
  if (!state.activeVersionId) return null;
  return state.versions.find((version) => version.id === state.activeVersionId) || null;
}

export function upsertPromptVersion(state: PromptState, version: PromptVersionRecord) {
  const next: PromptState = {
    ...cloneDefaultPromptState(),
    ...state,
    versions: state.versions.some((item) => item.id === version.id)
      ? state.versions.map((item) => (item.id === version.id ? { ...item, ...version, updatedAt: new Date().toISOString() } : item))
      : [...state.versions, version],
  };
  return next;
}

export function deletePromptVersion(state: PromptState, versionId: string) {
  const versions = state.versions.filter((version) => version.id !== versionId);
  const activeVersionId = state.activeVersionId === versionId ? null : state.activeVersionId;
  return { ...state, versions, activeVersionId };
}

export function setActivePromptVersion(state: PromptState, versionId: string | null) {
  return { ...state, activeVersionId: versionId };
}

function normalizePromptVersion(raw: unknown): PromptVersionRecord {
  const snapshot = normalizePromptSnapshot(raw as Partial<PromptSnapshot> | null | undefined);
  const input = raw as Partial<PromptVersionRecord>;
  return {
    id: typeof input.id === "string" ? input.id : crypto.randomUUID(),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
    ...snapshot,
    source: snapshot.source === "prompt_version" ? "prompt_version" : "runtime",
    versionId: null,
    name: typeof input.name === "string" ? input.name : snapshot.name ?? null,
  };
}

function safeSessionId(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "");
}

function isMissingFileError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}
