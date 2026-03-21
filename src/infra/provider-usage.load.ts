import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFetch } from "./fetch.js";
import { type ProviderAuth, resolveProviderAuths } from "./provider-usage.auth.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCopilotUsage,
  fetchGeminiUsage,
  fetchMinimaxUsage,
  fetchZaiUsage,
} from "./provider-usage.fetch.js";
import {
  DEFAULT_TIMEOUT_MS,
  ignoredErrors,
  PROVIDER_LABELS,
  usageProviders,
  withTimeout,
} from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  fetch?: typeof fetch;
};

type RouterSuppressionEntry = {
  reason: string;
  suppressedUntil: number;
};

type RouterSuppressionState = {
  blanket: RouterSuppressionEntry | null;
  perModel: Record<string, RouterSuppressionEntry>;
};

function formatSuppressionRemaining(targetMs: number, now: number): string {
  const diffMs = Math.max(0, targetMs - now);
  if (diffMs <= 60_000) {
    return "<1m";
  }
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function normalizeSuppressionEntry(entry: unknown, now: number): RouterSuppressionEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const rawReason = (entry as { reason?: unknown }).reason;
  const reason = (typeof rawReason === "string" ? rawReason : "").trim();
  // suppressed_until is stored in Unix seconds; convert to ms for comparison with Date.now()
  const suppressedUntil =
    Number((entry as { suppressed_until?: unknown }).suppressed_until ?? 0) * 1000;
  if (!reason || !Number.isFinite(suppressedUntil) || suppressedUntil <= now) {
    return null;
  }
  return { reason, suppressedUntil };
}

function normalizeSuppressionPayload(payload: unknown, now: number): RouterSuppressionState {
  if (!payload || typeof payload !== "object") {
    return { blanket: null, perModel: {} };
  }
  const record = payload as {
    blanket?: unknown;
    per_model?: Record<string, unknown>;
  };
  if (!("blanket" in record) && !("per_model" in record)) {
    return {
      blanket: normalizeSuppressionEntry(payload, now),
      perModel: {},
    };
  }

  const perModel: Record<string, RouterSuppressionEntry> = {};
  if (record.per_model && typeof record.per_model === "object") {
    for (const [modelRef, entry] of Object.entries(record.per_model)) {
      const normalized = normalizeSuppressionEntry(entry, now);
      if (normalized && modelRef.trim()) {
        perModel[modelRef.trim()] = normalized;
      }
    }
  }

  return {
    blanket: normalizeSuppressionEntry(record.blanket, now),
    perModel,
  };
}

function resolveRouterSuppressionPath(provider: UsageProviderId): string | null {
  const runtimeRoot = process.env.OPENCLAW_RUNTIME_DIR?.trim() || join(homedir(), ".openclaw");
  const tmpDir = join(runtimeRoot, "tmp");
  switch (provider) {
    case "anthropic":
      return join(tmpDir, "router-anthropic-suppression.json");
    case "openai-codex":
      return join(tmpDir, "router-openai-suppression.json");
    default:
      return null;
  }
}

function humanizeSuppressedModel(provider: UsageProviderId, modelRef: string): string {
  const normalized = modelRef.trim();
  if (provider === "anthropic") {
    if (normalized === "anthropic/claude-sonnet-4-6") {
      return "Sonnet";
    }
    if (normalized === "anthropic/claude-haiku-4") {
      return "Haiku";
    }
    if (normalized === "anthropic/claude-opus-4-6") {
      return "Opus";
    }
    if (normalized === "anthropic/claude-opus-4-1") {
      return "Opus";
    }
  }
  if (provider === "openai-codex") {
    if (normalized === "openai-codex/gpt-5.4") {
      return "GPT-5.4";
    }
    if (normalized === "openai-codex/gpt-5.3-codex-spark") {
      return "Codex Spark";
    }
  }
  const tail = normalized.split("/").pop()?.trim();
  return tail || normalized;
}

function resolveSuppressionNotes(provider: UsageProviderId, now: number): string[] {
  const path = resolveRouterSuppressionPath(provider);
  if (!path || !existsSync(path)) {
    return [];
  }

  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const state = normalizeSuppressionPayload(payload, now);
    if (state.blanket) {
      return [
        `provider paused ${formatSuppressionRemaining(state.blanket.suppressedUntil, now)} (${state.blanket.reason})`,
      ];
    }
    return Object.entries(state.perModel)
      .toSorted((a, b) => a[1].suppressedUntil - b[1].suppressedUntil)
      .slice(0, 2)
      .map(
        ([modelRef, entry]) =>
          `${humanizeSuppressedModel(provider, modelRef)} paused ${formatSuppressionRemaining(entry.suppressedUntil, now)} (${entry.reason})`,
      );
  } catch {
    return [];
  }
}

function withSuppressionNotes(snapshot: ProviderUsageSnapshot, now: number): ProviderUsageSnapshot {
  const notes = [...(snapshot.notes ?? []), ...resolveSuppressionNotes(snapshot.provider, now)];
  if (notes.length === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    notes: Array.from(new Set(notes)),
  };
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = resolveFetch(opts.fetch);
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const auths = await resolveProviderAuths({
    providers: opts.providers ?? usageProviders,
    auth: opts.auth,
    agentDir: opts.agentDir,
  });
  if (auths.length === 0) {
    return { updatedAt: now, providers: [] };
  }

  const tasks = auths.map((auth) =>
    withTimeout(
      (async (): Promise<ProviderUsageSnapshot> => {
        let snapshot: ProviderUsageSnapshot;
        switch (auth.provider) {
          case "anthropic":
            snapshot = await fetchClaudeUsage(auth.token, timeoutMs, fetchFn);
            break;
          case "github-copilot":
            snapshot = await fetchCopilotUsage(auth.token, timeoutMs, fetchFn);
            break;
          case "google-gemini-cli":
            snapshot = await fetchGeminiUsage(auth.token, timeoutMs, fetchFn, auth.provider);
            break;
          case "openai-codex":
            snapshot = await fetchCodexUsage(auth.token, auth.accountId, timeoutMs, fetchFn);
            break;
          case "minimax":
            snapshot = await fetchMinimaxUsage(auth.token, timeoutMs, fetchFn);
            break;
          case "xiaomi":
            snapshot = {
              provider: "xiaomi",
              displayName: PROVIDER_LABELS.xiaomi,
              windows: [],
            };
            break;
          case "zai":
            snapshot = await fetchZaiUsage(auth.token, timeoutMs, fetchFn);
            break;
          default:
            snapshot = {
              provider: auth.provider,
              displayName: PROVIDER_LABELS[auth.provider],
              windows: [],
              error: "Unsupported provider",
            };
            break;
        }
        return withSuppressionNotes(snapshot, now);
      })(),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
      },
    ),
  );

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) {
      return true;
    }
    if (!entry.error) {
      return true;
    }
    return !ignoredErrors.has(entry.error);
  });

  return { updatedAt: now, providers };
}
