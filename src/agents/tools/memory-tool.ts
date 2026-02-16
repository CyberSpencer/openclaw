import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { MemorySearchResult } from "../../memory/types.js";
import type { AnyAgentTool } from "./common.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);

        const scoped = await applyProjectScopeToMemoryResults({
          cfg,
          agentId,
          sessionKey: options.agentSessionKey,
          results: decorated,
        });

        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(scoped, resolved.qmd?.limits.maxInjectedChars)
            : scoped;

        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const allowed = await isMemoryPathAllowedForProjectScope({
          cfg,
          agentId,
          sessionKey: options.agentSessionKey,
          relPath,
        });
        if (!allowed.ok) {
          return jsonResult({
            path: relPath,
            text: "",
            disabled: true,
            error: allowed.reason,
          });
        }

        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}

type ProjectScope = {
  projectId: string;
  mode: "project-only" | "project+global";
};

type AllowedCheckResult = { ok: true } | { ok: false; reason: string };

function normalizeRelPath(value: string): string {
  return value
    .trim()
    .replace(/^\.*\/?/, "")
    .replace(/\\/g, "/");
}

function buildAllowedMemoryPrefixes(scope: ProjectScope): string[] {
  const id = scope.projectId.trim();
  const prefixes: string[] = [];

  const addGlobal = scope.mode === "project+global";
  if (addGlobal) {
    prefixes.push("MEMORY.md");
    prefixes.push("memory.md");
    prefixes.push("memory/");
  }

  // Project-scoped memory.
  prefixes.push(`projects/${id}/MEMORY.md`);
  prefixes.push(`projects/${id}/memory.md`);
  prefixes.push(`projects/${id}/memory/`);

  return prefixes;
}

function isPathAllowedByPrefixes(relPath: string, prefixes: string[]): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  for (const prefix of prefixes) {
    if (prefix.endsWith("/")) {
      if (normalized.startsWith(prefix)) {
        return true;
      }
      continue;
    }
    if (normalized === prefix) {
      return true;
    }
  }
  return false;
}

async function loadProjectScopeForSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): Promise<ProjectScope | null> {
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
  if (!projectId) {
    return null;
  }

  const mode: ProjectScope["mode"] =
    entry?.projectMemoryMode === "project-only" ? "project-only" : "project+global";
  return { projectId, mode };
}

async function applyProjectScopeToMemoryResults(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  results: MemorySearchResult[];
}): Promise<MemorySearchResult[]> {
  const scope = await loadProjectScopeForSession({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!scope) {
    return params.results;
  }

  const prefixes = buildAllowedMemoryPrefixes(scope);
  return params.results.filter((entry) => isPathAllowedByPrefixes(entry.path, prefixes));
}

async function isMemoryPathAllowedForProjectScope(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  relPath: string;
}): Promise<AllowedCheckResult> {
  const scope = await loadProjectScopeForSession({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!scope) {
    return { ok: true };
  }

  const prefixes = buildAllowedMemoryPrefixes(scope);
  if (isPathAllowedByPrefixes(params.relPath, prefixes)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Path not allowed for active project scope (${scope.projectId}, mode=${scope.mode}).`,
  };
}
