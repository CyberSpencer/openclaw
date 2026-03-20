import fs from "node:fs";
import path from "node:path";
import { createAsyncLock, writeJsonAtomic } from "../infra/json-files.js";
import {
  buildAgentLaneSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import { resolveStorePath } from "./sessions/paths.js";

type ThemeSummary = {
  id: string;
  label: string;
  brief?: string;
  status: ThemeStatus;
  canonicalSessionKey: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export const THEME_LABEL_MAX_LENGTH = 64;
export const THEME_BRIEF_MAX_LENGTH = 280;

export type ThemeStatus = "active" | "archived";

export type ThemeEntry = {
  label: string;
  brief?: string;
  status: ThemeStatus;
  canonicalSessionKey: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type ThemeStore = Record<string, ThemeEntry>;

const THEME_STORE_LOCKS = new Map<string, ReturnType<typeof createAsyncLock>>();

function getThemeStoreLock(pathname: string) {
  const key = path.resolve(pathname);
  let lock = THEME_STORE_LOCKS.get(key);
  if (!lock) {
    lock = createAsyncLock();
    THEME_STORE_LOCKS.set(key, lock);
  }
  return lock;
}

function isThemeEntry(value: unknown): value is ThemeEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ThemeEntry>;
  return (
    typeof candidate.label === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.canonicalSessionKey === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.lastUsedAt === "number"
  );
}

function normalizeThemeStore(raw: unknown): ThemeStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const next: ThemeStore = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!isThemeEntry(entry)) {
      continue;
    }
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) {
      continue;
    }
    next[normalizedId] = {
      label: entry.label.trim(),
      brief: normalizeThemeBrief(entry.brief),
      status: entry.status === "archived" ? "archived" : "active",
      canonicalSessionKey: entry.canonicalSessionKey.trim(),
      createdAt: Math.max(0, Math.floor(entry.createdAt)),
      updatedAt: Math.max(0, Math.floor(entry.updatedAt)),
      lastUsedAt: Math.max(0, Math.floor(entry.lastUsedAt)),
    };
  }
  return next;
}

export function resolveThemesStorePath(store?: string, opts?: { agentId?: string }) {
  const sessionsStorePath = resolveStorePath(store, { agentId: opts?.agentId });
  return path.join(path.dirname(path.resolve(sessionsStorePath)), "themes.json");
}

export function loadThemeStore(pathname: string): ThemeStore {
  try {
    if (!fs.existsSync(pathname)) {
      return {};
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return normalizeThemeStore(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export async function updateThemeStore<T>(
  pathname: string,
  fn: (store: ThemeStore) => Promise<T> | T,
): Promise<T> {
  const lock = getThemeStoreLock(pathname);
  return await lock(async () => {
    const store = loadThemeStore(pathname);
    const result = await fn(store);
    await writeJsonAtomic(pathname, store, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
    return result;
  });
}

export function normalizeThemeLabel(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, THEME_LABEL_MAX_LENGTH);
}

export function normalizeThemeBrief(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, THEME_BRIEF_MAX_LENGTH);
}

function normalizedThemeLabelKey(value: string): string {
  return value.trim().toLowerCase();
}

export function findThemeByLabel(
  store: ThemeStore,
  label: string | undefined | null,
): { id: string; entry: ThemeEntry } | null {
  const normalized = normalizedThemeLabelKey(String(label ?? ""));
  if (!normalized) {
    return null;
  }
  for (const [id, entry] of Object.entries(store)) {
    if (normalizedThemeLabelKey(entry.label) === normalized) {
      return { id, entry };
    }
  }
  return null;
}

export function resolveThemeLookup(
  store: ThemeStore,
  params: {
    id?: string | null;
    label?: string | null;
    includeArchived?: boolean;
    sessionKey?: string | null;
  },
): { id: string; entry: ThemeEntry } | null {
  const id = String(params.id ?? "").trim();
  if (id) {
    const entry = store[id];
    if (entry && (params.includeArchived === true || entry.status !== "archived")) {
      return { id, entry };
    }
  }
  const labelMatch = findThemeByLabel(store, params.label);
  if (labelMatch && (params.includeArchived === true || labelMatch.entry.status !== "archived")) {
    return labelMatch;
  }
  const sessionKey = String(params.sessionKey ?? "").trim();
  if (sessionKey) {
    for (const [candidateId, entry] of Object.entries(store)) {
      if (entry.canonicalSessionKey === sessionKey) {
        if (params.includeArchived !== true && entry.status === "archived") {
          return null;
        }
        return { id: candidateId, entry };
      }
    }
  }
  return null;
}

export function themeToSummary(id: string, entry: ThemeEntry): ThemeSummary {
  return {
    id,
    label: entry.label,
    brief: entry.brief,
    status: entry.status,
    canonicalSessionKey: entry.canonicalSessionKey,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

export function listThemeSummaries(
  store: ThemeStore,
  opts?: { includeArchived?: boolean; search?: string },
): ThemeSummary[] {
  const search = String(opts?.search ?? "")
    .trim()
    .toLowerCase();
  return Object.entries(store)
    .filter(([, entry]) => opts?.includeArchived === true || entry.status !== "archived")
    .map(([id, entry]) => themeToSummary(id, entry))
    .filter((entry) => {
      if (!search) {
        return true;
      }
      return [entry.label, entry.brief, entry.id, entry.canonicalSessionKey].some(
        (value) => typeof value === "string" && value.toLowerCase().includes(search),
      );
    })
    .toSorted((a, b) => {
      if (a.status !== b.status) {
        return a.status === "active" ? -1 : 1;
      }
      return b.lastUsedAt - a.lastUsedAt;
    });
}

export function resolveThemeSummaryForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  themeId?: string | null;
  includeArchived?: boolean;
}): ThemeSummary | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = normalizeAgentId(parsed?.agentId ?? resolveAgentIdFromSessionKey(sessionKey));
  const storePath = resolveThemesStorePath(params.cfg.session?.store, { agentId });
  const store = loadThemeStore(storePath);
  const match = resolveThemeLookup(store, {
    id: params.themeId,
    sessionKey,
    includeArchived: params.includeArchived,
  });
  return match ? themeToSummary(match.id, match.entry) : undefined;
}

export async function touchThemeUsage(params: {
  cfg: OpenClawConfig;
  agentId: string;
  themeId: string;
  usedAt?: number;
}) {
  const themeId = params.themeId.trim();
  if (!themeId) {
    return;
  }
  const usedAt = params.usedAt ?? Date.now();
  const storePath = resolveThemesStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  await updateThemeStore(storePath, (store) => {
    const entry = store[themeId];
    if (!entry) {
      return;
    }
    entry.updatedAt = Math.max(entry.updatedAt, usedAt);
    entry.lastUsedAt = Math.max(entry.lastUsedAt, usedAt);
  });
}

export async function ensureThemeAvailableForAgent(params: {
  cfg: OpenClawConfig;
  themeId: string;
  sourceAgentId: string;
  targetAgentId: string;
}): Promise<ThemeSummary | undefined> {
  const themeId = params.themeId.trim();
  if (!themeId) {
    return undefined;
  }
  const sourceAgentId = normalizeAgentId(params.sourceAgentId);
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  const sourceStorePath = resolveThemesStorePath(params.cfg.session?.store, {
    agentId: sourceAgentId,
  });
  const sourceStore = loadThemeStore(sourceStorePath);
  const sourceEntry = sourceStore[themeId];
  if (!sourceEntry) {
    return undefined;
  }
  if (sourceAgentId === targetAgentId) {
    return themeToSummary(themeId, sourceEntry);
  }
  const targetStorePath = resolveThemesStorePath(params.cfg.session?.store, {
    agentId: targetAgentId,
  });
  await updateThemeStore(targetStorePath, (store) => {
    const existing = store[themeId];
    if (existing) {
      return;
    }
    const now = Date.now();
    store[themeId] = {
      ...sourceEntry,
      canonicalSessionKey: buildAgentLaneSessionKey({ agentId: targetAgentId, themeId }),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
  });
  const targetStore = loadThemeStore(targetStorePath);
  const targetEntry = targetStore[themeId];
  return targetEntry ? themeToSummary(themeId, targetEntry) : undefined;
}

export function buildThemeContextBlock(theme: Pick<ThemeSummary, "label" | "brief">): string {
  const lines = [
    `[Theme Lane] Active lane: ${theme.label}`,
    theme.brief ? `[Theme Lane] Scope: ${theme.brief}` : undefined,
    "[Theme Lane] Stay aligned with this lane. If the user's request is clearly outside this scope, say so briefly and suggest switching lanes or starting a new one.",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
