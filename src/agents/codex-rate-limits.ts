import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexRateLimitBucketScope = "generic_codex" | "model_specific" | "account";

export type CodexRateLimitBucket = {
  bucketId: string;
  source: string;
  scope: CodexRateLimitBucketScope;
  modelRefs: string[];
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  rawKey?: string | null;
  /** Poller: nested rateLimitsByLimitId + limitName (e.g. GPT-5.3-Codex-Spark · 5h). */
  displayLabel?: string;
};

export type CodexRateLimitsSnapshot = {
  schemaVersion: number;
  checkedAt: number;
  source: string;
  codexCliVersion?: string;
  account?: {
    type?: string;
    email?: string;
    planType?: string;
    requiresOpenaiAuth?: boolean;
  };
  buckets: CodexRateLimitBucket[];
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
  models?: Array<{
    id: string;
    model: string;
    displayName: string;
    isDefault?: boolean;
  }>;
  raw?: Record<string, unknown>;
};

export type CodexRateLimitModelStatus = {
  status: "unavailable" | "stale" | "ok" | "hot" | "exhausted";
  checkedAt?: number;
  activeBucket?: CodexRateLimitBucket;
  buckets: CodexRateLimitBucket[];
};

export type CodexRateLimitSummary = {
  source: "codex-app-server";
  checkedAt?: number;
  stale: boolean;
  status: "available" | "stale" | "unavailable";
  accountType?: string;
  planType?: string;
  buckets: Array<
    CodexRateLimitBucket & {
      resetsInMs?: number;
    }
  >;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
};

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_WARN_THRESHOLD = 95;
const DEFAULT_EXHAUSTED_THRESHOLD = 100;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function resolveCodexRateLimitSnapshotPath(): string {
  const runtimeRoot = process.env.OPENCLAW_RUNTIME_DIR;
  const tmpDir = runtimeRoot
    ? path.join(runtimeRoot, "tmp")
    : path.join(os.homedir(), ".openclaw", "tmp");
  return path.join(tmpDir, "codex-rate-limits.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeBucket(value: unknown): CodexRateLimitBucket | null {
  if (!isRecord(value)) {
    return null;
  }
  const bucketId = (typeof value.bucketId === "string" ? value.bucketId : "").trim();
  const source = (typeof value.source === "string" ? value.source : "").trim();
  if (!bucketId || !source) {
    return null;
  }
  const scopeRaw = (typeof value.scope === "string" ? value.scope : "account").trim();
  const scope: CodexRateLimitBucketScope =
    scopeRaw === "generic_codex" || scopeRaw === "model_specific" ? scopeRaw : "account";
  const refsRaw = Array.isArray(value.modelRefs) ? value.modelRefs : [];
  const modelRefs = refsRaw
    .map((item) => String(item ?? "").trim())
    .filter((item): item is string => item.length > 0);
  const displayLabelRaw = value.displayLabel;
  return {
    bucketId,
    source,
    scope,
    modelRefs,
    usedPercent: coerceInt(value.usedPercent),
    windowDurationMins: coerceInt(value.windowDurationMins),
    resetsAt: coerceInt(value.resetsAt),
    rawKey: typeof value.rawKey === "string" ? value.rawKey : undefined,
    displayLabel:
      typeof displayLabelRaw === "string" && displayLabelRaw.trim().length > 0
        ? displayLabelRaw.trim()
        : undefined,
  };
}

export function loadCodexRateLimitSnapshot(
  snapshotPath: string = resolveCodexRateLimitSnapshotPath(),
): CodexRateLimitsSnapshot | null {
  try {
    if (!fs.existsSync(snapshotPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const bucketsRaw = Array.isArray(parsed.buckets) ? parsed.buckets : [];
    return {
      schemaVersion: coerceInt(parsed.schemaVersion) ?? 1,
      checkedAt: coerceInt(parsed.checkedAt) ?? 0,
      source: typeof parsed.source === "string" ? parsed.source : "codex-app-server",
      codexCliVersion:
        typeof parsed.codexCliVersion === "string" ? parsed.codexCliVersion : undefined,
      account: isRecord(parsed.account)
        ? {
            type: typeof parsed.account.type === "string" ? parsed.account.type : undefined,
            email: typeof parsed.account.email === "string" ? parsed.account.email : undefined,
            planType:
              typeof parsed.account.planType === "string" ? parsed.account.planType : undefined,
            requiresOpenaiAuth:
              typeof parsed.account.requiresOpenaiAuth === "boolean"
                ? parsed.account.requiresOpenaiAuth
                : undefined,
          }
        : undefined,
      buckets: bucketsRaw
        .map((bucket) => normalizeBucket(bucket))
        .filter((bucket): bucket is CodexRateLimitBucket => bucket !== null),
      credits: isRecord(parsed.credits)
        ? {
            hasCredits:
              typeof parsed.credits.hasCredits === "boolean"
                ? parsed.credits.hasCredits
                : undefined,
            unlimited:
              typeof parsed.credits.unlimited === "boolean" ? parsed.credits.unlimited : undefined,
            balance:
              typeof parsed.credits.balance === "string" ? parsed.credits.balance : undefined,
          }
        : undefined,
      models: Array.isArray(parsed.models)
        ? parsed.models
            .filter((model) => isRecord(model))
            .map((model) => ({
              id: typeof model.id === "string" ? model.id : "",
              model: typeof model.model === "string" ? model.model : "",
              displayName:
                typeof model.displayName === "string"
                  ? model.displayName
                  : typeof model.model === "string"
                    ? model.model
                    : "",
              isDefault: typeof model.isDefault === "boolean" ? model.isDefault : undefined,
            }))
        : undefined,
      raw: isRecord(parsed.raw) ? parsed.raw : undefined,
    };
  } catch {
    return null;
  }
}

export function resolveCodexRateLimitStatusForModel(
  modelRef: string,
  snapshot: CodexRateLimitsSnapshot | null,
  nowMs: number = Date.now(),
): CodexRateLimitModelStatus {
  if (!snapshot) {
    return { status: "unavailable", buckets: [] };
  }
  const staleAfterMs = envInt("OPENCLAW_CODEX_RATE_LIMIT_STALE_AFTER_MS", DEFAULT_STALE_AFTER_MS);
  if (!snapshot.checkedAt || nowMs - snapshot.checkedAt > staleAfterMs) {
    return { status: "stale", checkedAt: snapshot.checkedAt, buckets: snapshot.buckets };
  }
  const applicable = snapshot.buckets
    .filter((bucket) => bucket.modelRefs.includes(modelRef))
    .toSorted((a, b) => {
      const usedDiff = (b.usedPercent ?? 0) - (a.usedPercent ?? 0);
      if (usedDiff !== 0) {
        return usedDiff;
      }
      return (a.resetsAt ?? Number.MAX_SAFE_INTEGER) - (b.resetsAt ?? Number.MAX_SAFE_INTEGER);
    });

  const exhaustedThreshold = envInt(
    "OPENCLAW_CODEX_RATE_LIMIT_EXHAUSTED_THRESHOLD",
    DEFAULT_EXHAUSTED_THRESHOLD,
  );
  const exhaustedBucket = applicable.find(
    (bucket) =>
      (bucket.usedPercent ?? 0) >= exhaustedThreshold &&
      typeof bucket.resetsAt === "number" &&
      bucket.resetsAt > nowMs,
  );
  if (exhaustedBucket) {
    return {
      status: "exhausted",
      checkedAt: snapshot.checkedAt,
      activeBucket: exhaustedBucket,
      buckets: applicable,
    };
  }

  const warnThreshold = envInt("OPENCLAW_CODEX_RATE_LIMIT_WARN_THRESHOLD", DEFAULT_WARN_THRESHOLD);
  const hotBucket = applicable.find((bucket) => (bucket.usedPercent ?? 0) >= warnThreshold);
  if (hotBucket) {
    return {
      status: "hot",
      checkedAt: snapshot.checkedAt,
      activeBucket: hotBucket,
      buckets: applicable,
    };
  }
  return { status: "ok", checkedAt: snapshot.checkedAt, buckets: applicable };
}

export function buildCodexRateLimitSummary(
  snapshot: CodexRateLimitsSnapshot | null,
  nowMs: number = Date.now(),
): CodexRateLimitSummary {
  if (!snapshot) {
    return { source: "codex-app-server", stale: true, status: "unavailable", buckets: [] };
  }
  const staleAfterMs = envInt("OPENCLAW_CODEX_RATE_LIMIT_STALE_AFTER_MS", DEFAULT_STALE_AFTER_MS);
  const stale = !snapshot.checkedAt || nowMs - snapshot.checkedAt > staleAfterMs;
  return {
    source: "codex-app-server",
    checkedAt: snapshot.checkedAt || undefined,
    stale,
    status: stale ? "stale" : "available",
    accountType: snapshot.account?.type,
    planType: snapshot.account?.planType,
    buckets: snapshot.buckets.map((bucket) => ({
      ...bucket,
      resetsInMs: bucket.resetsAt ? Math.max(0, bucket.resetsAt - nowMs) : undefined,
    })),
    credits: snapshot.credits,
  };
}
