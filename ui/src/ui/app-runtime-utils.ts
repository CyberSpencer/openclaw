import type { SessionsListResult } from "./types.ts";
import type { TaskPlan } from "./ui-types.ts";

/** Max chars per TTS chunk to stay under DGX timeout (~60s). ~250 chars ~= 12-15s under load. */
const MAX_TTS_CHARS = 250;
const SUBAGENT_RECENT_WINDOW_MS = 5 * 60_000;

/**
 * Chunk text for TTS to avoid DGX timeouts. Long text (~1270 chars) takes 60–78s;
 * chunks of ~250 chars stay under the 60s gateway timeout.
 * Prefers sentence boundaries; falls back to space; hard-breaks at maxChars.
 */
export function chunkTextForTts(text: string, maxChars = MAX_TTS_CHARS): string[] {
  const t = text.trim();
  if (!t) {
    return [];
  }
  if (t.length <= maxChars) {
    return [t];
  }

  const chunks: string[] = [];
  let rest = t;

  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      chunks.push(rest.trim());
      break;
    }
    const window = rest.slice(0, maxChars);
    const sentMatches = [...window.matchAll(/[.!?]\s+/g)];
    const lastSent = sentMatches[sentMatches.length - 1];
    const lastSpace = window.lastIndexOf(" ");
    const breakAt = lastSent
      ? lastSent.index + lastSent[0].length
      : lastSpace > 0
        ? lastSpace + 1
        : maxChars;

    chunks.push(rest.slice(0, breakAt).trim());
    rest = rest.slice(breakAt).trim();
  }

  return chunks;
}

export function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export type SparkStatusResult = {
  enabled?: boolean;
  active?: boolean;
  source?: "dgx-stats" | "fallback";
  host?: string | null;
  checkedAt?: number;
  voiceAvailable?: boolean;
  overall?: "healthy" | "degraded" | "down" | "unknown";
  counts?: { healthy: number; degraded: number; down: number; total: number };
  services?: Record<
    string,
    { url?: string; healthy?: boolean; status?: number; error?: string | null; latency_ms?: number }
  >;
  gpu?: {
    name?: string;
    temperature_c?: number;
    power_w?: number;
    utilization_pct?: number;
    memory_used_mib?: number;
    memory_total_mib?: number;
    unified_memory?: boolean;
    processes?: Array<{ pid: number; memory_mib: number; process: string }>;
  } | null;
  containers?: Array<{
    name: string;
    cpu?: string;
    memory?: string;
    mem_pct?: string;
    net_io?: string;
    block_io?: string;
  }> | null;
};

export type OrchestratorGetResult = {
  exists?: boolean;
  hash?: string;
  scopeKey?: string;
  state?: {
    version?: unknown;
    selectedBoardId?: unknown;
    boards?: unknown;
  };
};

export type OrchestratorSetResult = {
  hash?: string;
  scopeKey?: string;
};

export type CodexTeamRunResult = {
  runId?: string;
  sessionKey?: string;
};

export type SessionSpawnResult = {
  status?: string;
  error?: string;
  childSessionKey?: string;
  runId?: string;
  warning?: string;
};

export type SessionsSubagentsResult = {
  tasks?: Array<{
    runId?: string;
    childSessionKey?: string;
    status?: "running" | "done" | "error";
    startedAt?: number;
    endedAt?: number;
  }>;
};

export type AgentWaitResult = {
  status?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
};

export type ConfigGetResult = {
  hash?: string;
  config?: Record<string, unknown> | null;
};

export type DoctorRunResult = {
  ok?: boolean;
  exitCode?: number;
  signal?: string;
  durationMs?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
};

export type RouterStatusResult = {
  enabled?: boolean;
  healthy?: boolean;
};

export type RouterSetEnabledResult = {
  enabled?: boolean;
  healthy?: boolean;
};

export type SparkVoiceTtsResult = {
  audio_base64?: string;
  format?: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveMemorySearchEnabled(
  config: Record<string, unknown> | null | undefined,
): boolean {
  const agents = asObject(config?.agents);
  const defaults = asObject(agents?.defaults);
  const memorySearch = asObject(defaults?.memorySearch);
  if (!memorySearch) {
    return true;
  }
  const enabled = memorySearch.enabled;
  return typeof enabled === "boolean" ? enabled : true;
}

/**
 * Resolve a human-readable label for the memory search store.
 * Returns e.g. "Qdrant (127.0.0.1)" or "SQLite" or "Auto".
 */
export function resolveMemoryStoreLabel(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const agents = asObject(config?.agents);
  const defaults = asObject(agents?.defaults);
  const memorySearch = asObject(defaults?.memorySearch);
  if (!memorySearch) {
    return null;
  }
  const store = asObject(memorySearch.store);
  if (!store) {
    return null;
  }

  const driver = typeof store.driver === "string" ? store.driver.toLowerCase().trim() : "auto";

  const qdrantConfig = asObject(store.qdrant);

  // Prefer the endpoints array (priority-based failover) over the legacy url field.
  const endpoints = Array.isArray(qdrantConfig?.endpoints) ? qdrantConfig.endpoints : null;
  let effectiveUrl: string | null = null;

  if (endpoints && endpoints.length > 0) {
    // Pick the endpoint with the lowest priority number (highest precedence).
    let bestPriority = Infinity;
    for (const ep of endpoints) {
      const obj = asObject(ep);
      if (!obj || typeof obj.url !== "string") {
        continue;
      }
      const pri = typeof obj.priority === "number" ? obj.priority : 999;
      if (pri < bestPriority) {
        bestPriority = pri;
        effectiveUrl = obj.url.trim();
      }
    }
  }

  // Fall back to the legacy url field if no endpoints were found.
  if (!effectiveUrl && typeof qdrantConfig?.url === "string") {
    effectiveUrl = qdrantConfig.url.trim() || null;
  }

  if (driver === "qdrant" || (driver === "auto" && effectiveUrl)) {
    if (effectiveUrl) {
      try {
        const parsed = new URL(effectiveUrl);
        const isLocal =
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "localhost" ||
          parsed.hostname === "::1";
        return isLocal ? "Mac" : "DGX";
      } catch {
        return "Mac";
      }
    }
    return "Mac";
  }

  if (driver === "sqlite") {
    return "Mac";
  }
  return "Mac";
}

function normalizeTaskStatus(value: unknown): string {
  if (typeof value !== "string") {
    return "todo";
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "todo" ||
    normalized === "running" ||
    normalized === "done" ||
    normalized === "blocked" ||
    normalized === "skipped"
  ) {
    return normalized;
  }
  return "todo";
}

export function isTaskPlanIncomplete(plan: TaskPlan | null | undefined): boolean {
  const tasks = plan?.tasks ?? [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return false;
  }
  const done = tasks.filter((task) => {
    const status = normalizeTaskStatus((task as { status?: unknown }).status);
    return status === "done" || status === "skipped";
  }).length;
  return done < tasks.length;
}

export function hasRecentSubagentActivity(result: SessionsListResult | null | undefined): boolean {
  const sessions = result?.sessions ?? [];
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return false;
  }
  let maxUpdatedAt = 0;
  for (const row of sessions) {
    const ts = typeof row.updatedAt === "number" ? row.updatedAt : 0;
    if (ts > maxUpdatedAt) {
      maxUpdatedAt = ts;
    }
  }
  if (maxUpdatedAt <= 0) {
    return false;
  }
  return Date.now() - maxUpdatedAt < SUBAGENT_RECENT_WINDOW_MS;
}
