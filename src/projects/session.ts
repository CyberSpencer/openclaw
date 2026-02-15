import type { OpenClawConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";

export type ResolvedProjectSessionScope = {
  projectId: string;
  projectMemoryMode: NonNullable<SessionEntry["projectMemoryMode"]>;
  storePath: string;
  sessionEntry: SessionEntry;
  sessionStoreKey: string;
};

export function resolveProjectSessionScope(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): ResolvedProjectSessionScope | null {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const store = loadSessionStore(storePath);

  const normalized = rawSessionKey.toLowerCase();
  let candidateKey = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: normalized,
  });
  if (
    candidateKey !== "global" &&
    candidateKey !== "unknown" &&
    !candidateKey.startsWith("agent:")
  ) {
    candidateKey = `agent:${params.agentId}:${candidateKey}`;
  }

  const entry: SessionEntry | undefined =
    store[candidateKey] ?? store[normalized] ?? store[rawSessionKey];
  const projectId = entry?.projectId?.trim();
  if (!entry || !projectId) {
    return null;
  }
  const projectMemoryMode = entry.projectMemoryMode ?? "project+global";
  return {
    projectId,
    projectMemoryMode,
    storePath,
    sessionEntry: entry,
    sessionStoreKey: candidateKey,
  };
}
