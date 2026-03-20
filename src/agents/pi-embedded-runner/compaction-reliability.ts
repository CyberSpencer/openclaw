import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { logCompactionEvent } from "../../logging/diagnostic.js";

export type CompactionEventKind = "decision" | "attempt" | "result";

export type CompactionReasonCode =
  | "sdk_compacted"
  | "explicit_compacted"
  | "explicit_failed"
  | "truncated"
  | "timeout_race"
  | "breaker_open"
  | "hard_cap"
  | "no_op"
  | "duplicate_in_flight";

export type OverflowWarningState = "recovering" | "hard_stop";

export type OverflowWarningMeta = {
  state: OverflowWarningState;
  reasonCode: CompactionReasonCode;
  attempt: number;
  diagId?: string;
};

export type CompactionReliabilityPolicy = {
  maxExplicitRetries: number;
  breakerEnabled: boolean;
  breakerWindowMs: number;
  maxFailuresBeforeCooldown: number;
  cooldownMs: number;
  adaptiveFloorMultiplier: number;
  adaptiveCeilingMultiplier: number;
  adaptiveTightenStep: number;
  adaptiveRelaxStep: number;
  adaptiveRecoveryHysteresis: number;
  explicitTimeoutMs: number;
  retryAggregateTimeoutMs: number;
  retryPollIntervalMs: number;
};

type FailureRecord = {
  ts: number;
  reasonCode: CompactionReasonCode;
};

export type CompactionReliabilityMetrics = {
  attempts: number;
  overflows: number;
  recoveries: number;
  truncations: number;
  failures: number;
  failureByReason: Partial<Record<CompactionReasonCode, number>>;
};

export type CompactionReliabilityState = {
  sessionId: string;
  consecutiveRecoveries: number;
  adaptiveMultiplier: number;
  cooldownUntil: number;
  failureWindow: FailureRecord[];
  inFlightFingerprints: Set<string>;
  metrics: CompactionReliabilityMetrics;
};

type CompactionReliabilityGlobalState = {
  sessions: Map<string, CompactionReliabilityState>;
};

const DEFAULT_MAX_EXPLICIT_RETRIES = 3;
const DEFAULT_BREAKER_WINDOW_MS = 5 * 60_000;
const DEFAULT_BREAKER_MAX_FAILURES = 2;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_ADAPTIVE_FLOOR_MULTIPLIER = 1;
const DEFAULT_ADAPTIVE_CEILING_MULTIPLIER = 1;
const DEFAULT_ADAPTIVE_TIGHTEN_STEP = 0.15;
const DEFAULT_ADAPTIVE_RELAX_STEP = 0.1;
const DEFAULT_ADAPTIVE_RECOVERY_HYSTERESIS = 2;
const DEFAULT_EXPLICIT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

function getCompactionReliabilityGlobalState(): CompactionReliabilityGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawCompactionReliabilityState?: CompactionReliabilityGlobalState;
  };
  if (!globalStore.__openclawCompactionReliabilityState) {
    globalStore.__openclawCompactionReliabilityState = {
      sessions: new Map<string, CompactionReliabilityState>(),
    };
  }
  return globalStore.__openclawCompactionReliabilityState;
}

function readIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

function readFloatEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return undefined;
}

function clampInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.floor(value));
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0.1, value));
}

function pruneFailures(
  state: CompactionReliabilityState,
  policy: CompactionReliabilityPolicy,
): void {
  const minTs = Date.now() - policy.breakerWindowMs;
  state.failureWindow = state.failureWindow.filter((entry) => entry.ts >= minTs);
}

function createInitialState(
  sessionId: string,
  policy: CompactionReliabilityPolicy,
): CompactionReliabilityState {
  return {
    sessionId,
    consecutiveRecoveries: 0,
    adaptiveMultiplier: policy.adaptiveCeilingMultiplier,
    cooldownUntil: 0,
    failureWindow: [],
    inFlightFingerprints: new Set<string>(),
    metrics: {
      attempts: 0,
      overflows: 0,
      recoveries: 0,
      truncations: 0,
      failures: 0,
      failureByReason: {},
    },
  };
}

export function resolveCompactionReliabilityPolicy(
  cfg?: OpenClawConfig,
): CompactionReliabilityPolicy {
  const reliability = cfg?.agents?.defaults?.compaction?.reliability;

  const breakerEnabled =
    readBooleanEnv("OPENCLAW_COMPACTION_BREAKER_ENABLED") ?? reliability?.breakerEnabled ?? false;
  const breakerWindowMs = clampInt(
    readIntEnv("OPENCLAW_COMPACTION_BREAKER_WINDOW_MS") ?? reliability?.breakerWindowMs,
    DEFAULT_BREAKER_WINDOW_MS,
    1,
  );
  const maxFailuresBeforeCooldown = clampInt(
    readIntEnv("OPENCLAW_COMPACTION_BREAKER_MAX_FAILURES") ??
      reliability?.maxFailuresBeforeCooldown,
    DEFAULT_BREAKER_MAX_FAILURES,
    1,
  );
  const cooldownMs = clampInt(
    readIntEnv("OPENCLAW_COMPACTION_BREAKER_COOLDOWN_MS") ?? reliability?.cooldownMs,
    DEFAULT_BREAKER_COOLDOWN_MS,
    1,
  );
  const adaptiveFloorMultiplier = clampRatio(
    readFloatEnv("OPENCLAW_COMPACTION_ADAPTIVE_FLOOR_MULTIPLIER") ??
      reliability?.adaptiveFloorMultiplier,
    DEFAULT_ADAPTIVE_FLOOR_MULTIPLIER,
  );
  const adaptiveCeilingMultiplier = clampRatio(
    readFloatEnv("OPENCLAW_COMPACTION_ADAPTIVE_CEILING_MULTIPLIER") ??
      reliability?.adaptiveCeilingMultiplier,
    DEFAULT_ADAPTIVE_CEILING_MULTIPLIER,
  );

  return {
    maxExplicitRetries: clampInt(
      readIntEnv("OPENCLAW_COMPACTION_MAX_EXPLICIT_RETRIES") ?? reliability?.maxExplicitRetries,
      DEFAULT_MAX_EXPLICIT_RETRIES,
      1,
    ),
    breakerEnabled,
    breakerWindowMs,
    maxFailuresBeforeCooldown,
    cooldownMs,
    adaptiveFloorMultiplier: Math.min(adaptiveFloorMultiplier, adaptiveCeilingMultiplier),
    adaptiveCeilingMultiplier: Math.max(adaptiveFloorMultiplier, adaptiveCeilingMultiplier),
    adaptiveTightenStep: clampRatio(
      readFloatEnv("OPENCLAW_COMPACTION_ADAPTIVE_TIGHTEN_STEP") ?? reliability?.adaptiveTightenStep,
      DEFAULT_ADAPTIVE_TIGHTEN_STEP,
    ),
    adaptiveRelaxStep: clampRatio(
      readFloatEnv("OPENCLAW_COMPACTION_ADAPTIVE_RELAX_STEP") ?? reliability?.adaptiveRelaxStep,
      DEFAULT_ADAPTIVE_RELAX_STEP,
    ),
    adaptiveRecoveryHysteresis: clampInt(
      readIntEnv("OPENCLAW_COMPACTION_ADAPTIVE_RECOVERY_HYSTERESIS") ??
        reliability?.adaptiveRecoveryHysteresis,
      DEFAULT_ADAPTIVE_RECOVERY_HYSTERESIS,
      1,
    ),
    explicitTimeoutMs: clampInt(
      readIntEnv("OPENCLAW_COMPACTION_TIMEOUT_MS") ?? reliability?.explicitTimeoutMs,
      DEFAULT_EXPLICIT_TIMEOUT_MS,
      1,
    ),
    retryAggregateTimeoutMs: clampInt(
      readIntEnv("OPENCLAW_COMPACTION_RETRY_TIMEOUT_MS") ?? reliability?.retryAggregateTimeoutMs,
      DEFAULT_RETRY_AGGREGATE_TIMEOUT_MS,
      1,
    ),
    retryPollIntervalMs: clampInt(
      readIntEnv("OPENCLAW_COMPACTION_RETRY_POLL_MS") ?? reliability?.retryPollIntervalMs,
      DEFAULT_RETRY_POLL_INTERVAL_MS,
      1,
    ),
  };
}

export function getCompactionReliabilityState(
  sessionId: string,
  cfg?: OpenClawConfig,
): CompactionReliabilityState {
  const policy = resolveCompactionReliabilityPolicy(cfg);
  const globalState = getCompactionReliabilityGlobalState();
  let state = globalState.sessions.get(sessionId);
  if (!state) {
    state = createInitialState(sessionId, policy);
    globalState.sessions.set(sessionId, state);
  }
  return state;
}

export function resetCompactionReliabilityStateForTest(sessionId?: string): void {
  const globalState = getCompactionReliabilityGlobalState();
  if (sessionId) {
    globalState.sessions.delete(sessionId);
    return;
  }
  globalState.sessions.clear();
}

export function recordOverflowSeen(state: CompactionReliabilityState): void {
  state.metrics.overflows += 1;
}

export function isCompactionBreakerOpen(
  state: CompactionReliabilityState,
  cfg?: OpenClawConfig,
): boolean {
  const policy = resolveCompactionReliabilityPolicy(cfg);
  if (!policy.breakerEnabled) {
    return false;
  }
  pruneFailures(state, policy);
  if (state.cooldownUntil <= Date.now()) {
    state.cooldownUntil = 0;
  }
  return state.cooldownUntil > Date.now();
}

export function noteExplicitCompactionAttempt(state: CompactionReliabilityState): void {
  state.metrics.attempts += 1;
}

export function noteCompactionFailure(
  state: CompactionReliabilityState,
  reasonCode: CompactionReasonCode,
  cfg?: OpenClawConfig,
): void {
  const policy = resolveCompactionReliabilityPolicy(cfg);
  state.consecutiveRecoveries = 0;
  state.metrics.failures += 1;
  state.metrics.failureByReason[reasonCode] = (state.metrics.failureByReason[reasonCode] ?? 0) + 1;
  state.failureWindow.push({ ts: Date.now(), reasonCode });
  pruneFailures(state, policy);
  if (policy.breakerEnabled && state.failureWindow.length >= policy.maxFailuresBeforeCooldown) {
    state.cooldownUntil = Date.now() + policy.cooldownMs;
  }
  state.adaptiveMultiplier = Math.max(
    policy.adaptiveFloorMultiplier,
    state.adaptiveMultiplier - policy.adaptiveTightenStep,
  );
}

export function noteCompactionRecovery(
  state: CompactionReliabilityState,
  reasonCode: "sdk_compacted" | "explicit_compacted" | "truncated",
  cfg?: OpenClawConfig,
): void {
  const policy = resolveCompactionReliabilityPolicy(cfg);
  state.metrics.recoveries += 1;
  if (reasonCode === "truncated") {
    state.metrics.truncations += 1;
  }
  state.consecutiveRecoveries += 1;
  state.failureWindow = [];
  state.cooldownUntil = 0;
  if (state.consecutiveRecoveries >= policy.adaptiveRecoveryHysteresis) {
    state.adaptiveMultiplier = Math.min(
      policy.adaptiveCeilingMultiplier,
      state.adaptiveMultiplier + policy.adaptiveRelaxStep,
    );
    state.consecutiveRecoveries = 0;
  }
}

export function reserveCompactionExecution(
  state: CompactionReliabilityState,
  fingerprint: string,
): boolean {
  if (state.inFlightFingerprints.has(fingerprint)) {
    return false;
  }
  state.inFlightFingerprints.add(fingerprint);
  return true;
}

export function releaseCompactionExecution(
  state: CompactionReliabilityState,
  fingerprint: string,
): void {
  state.inFlightFingerprints.delete(fingerprint);
}

export function resolveAdaptiveToolResultContextShare(state: CompactionReliabilityState): number {
  return Math.max(
    0.05,
    Math.min(0.9, DEFAULT_MAX_TOOL_RESULT_CONTEXT_SHARE * state.adaptiveMultiplier),
  );
}

function getMessageTextChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

export function summarizeCompactionMessages(messages?: AgentMessage[]): {
  inputChars?: number;
  toolResultChars?: number;
} {
  if (!messages || messages.length === 0) {
    return {};
  }
  let inputChars = 0;
  let toolResultChars = 0;
  for (const message of messages) {
    const chars = getMessageTextChars(message);
    inputChars += chars;
    if ((message as { role?: unknown }).role === "toolResult") {
      toolResultChars += chars;
    }
  }
  return { inputChars, toolResultChars };
}

export function emitCompactionDiagnostic(params: {
  event: CompactionEventKind;
  reasonCode: CompactionReasonCode;
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  attempt?: number;
  diagId?: string;
  budget?: number;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
  cfg?: OpenClawConfig;
}): void {
  const state = getCompactionReliabilityState(params.sessionId, params.cfg);
  const attempts = state.metrics.attempts;
  const failureRate = attempts > 0 ? state.metrics.failures / attempts : 0;
  const overflowRecoveryRatio =
    state.metrics.overflows > 0 ? state.metrics.recoveries / state.metrics.overflows : 0;
  const truncationRatio =
    state.metrics.recoveries > 0 ? state.metrics.truncations / state.metrics.recoveries : 0;

  logCompactionEvent({
    event: params.event,
    reasonCode: params.reasonCode,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    messageId: params.messageId,
    attempt: params.attempt,
    diagId: params.diagId,
    correlationId: params.diagId,
    budget: params.budget,
    elapsedMs: params.elapsedMs,
    inputChars: params.inputChars,
    outputChars: params.outputChars,
    adaptiveMultiplier: state.adaptiveMultiplier,
    attempts,
    failureRate,
    overflowRecoveryRatio,
    truncationRatio,
  });
}
