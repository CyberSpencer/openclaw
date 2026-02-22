import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  collectCronSource,
  collectMessagingSource,
  collectOrchestratorSource,
  collectSessionsSource,
  collectUsageSource,
  createFallbackSources,
  sourceConfidence,
  uniqueWarnings,
} from "./executive-brief.sources.js";
import {
  DEFAULT_BRIEF_WINDOWS,
  type ExecutiveBriefAction,
  type ExecutiveBriefPayload,
  type ExecutiveBriefPreset,
  type ExecutiveBriefSources,
  type ExecutiveBriefWindows,
} from "./executive-brief.types.js";

type BuildExecutiveBriefParams = {
  context: GatewayRequestContext;
  preset?: string;
  windows?: Partial<ExecutiveBriefWindows>;
  topActionsLimit?: number;
};

function clampWindowMinutes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(5, Math.min(7 * 24 * 60, Math.floor(value)));
}

function resolvePreset(raw: string | undefined): ExecutiveBriefPreset {
  return raw === "pm" ? "pm" : "am";
}

function resolveWindows(
  preset: ExecutiveBriefPreset,
  rawWindows: Partial<ExecutiveBriefWindows> | undefined,
): ExecutiveBriefWindows {
  const defaults = DEFAULT_BRIEF_WINDOWS[preset];
  return {
    sessionsMinutes: clampWindowMinutes(rawWindows?.sessionsMinutes, defaults.sessionsMinutes),
    usageMinutes: clampWindowMinutes(rawWindows?.usageMinutes, defaults.usageMinutes),
    orchestratorMinutes: clampWindowMinutes(
      rawWindows?.orchestratorMinutes,
      defaults.orchestratorMinutes,
    ),
    cronMinutes: clampWindowMinutes(rawWindows?.cronMinutes, defaults.cronMinutes),
    messagingMinutes: clampWindowMinutes(rawWindows?.messagingMinutes, defaults.messagingMinutes),
  };
}

function normalizeConfidence(value: number): number {
  return Math.max(0.1, Math.min(0.99, Number(value.toFixed(2))));
}

function calculateActionScore(severity: number, confidence: number): number {
  return Math.round(severity * (0.6 + confidence * 0.4));
}

export function rankExecutiveBriefActions(
  sources: ExecutiveBriefSources,
  opts?: { topActionsLimit?: number },
): ExecutiveBriefAction[] {
  const limit = Math.max(1, Math.min(5, opts?.topActionsLimit ?? 3));
  const candidates: ExecutiveBriefAction[] = [];

  if (sources.messaging.errorAccounts > 0) {
    const confidence = normalizeConfidence(sourceConfidence(sources.messaging.status));
    candidates.push({
      id: "messaging-errors",
      title: "Stabilize messaging channel health",
      rationale: `${sources.messaging.errorAccounts} account(s) report connection/auth errors. Resolve before inbound messages queue up.`,
      confidence,
      score: calculateActionScore(95, confidence),
      source: "messaging",
    });
  }

  if (sources.cron.failingJobs > 0 || sources.cron.overdueJobs > 0) {
    const confidence = normalizeConfidence(sourceConfidence(sources.cron.status));
    candidates.push({
      id: "cron-failures",
      title: "Fix failing or overdue cron jobs",
      rationale: `${sources.cron.failingJobs} failing and ${sources.cron.overdueJobs} overdue cron job(s) detected.`,
      confidence,
      score: calculateActionScore(90, confidence),
      source: "cron",
    });
  }

  if (sources.orchestrator.failedCards > 0 || sources.orchestrator.reviewCards > 0) {
    const confidence = normalizeConfidence(sourceConfidence(sources.orchestrator.status));
    candidates.push({
      id: "orchestrator-triage",
      title: "Triage orchestration queue",
      rationale: `${sources.orchestrator.failedCards} failed card(s) and ${sources.orchestrator.reviewCards} awaiting review.`,
      confidence,
      score: calculateActionScore(84, confidence),
      source: "orchestrator",
    });
  }

  if (sources.usage.totals.totalTokens > 150_000 || sources.usage.totals.totalCost > 5) {
    const confidence = normalizeConfidence(sourceConfidence(sources.usage.status));
    candidates.push({
      id: "usage-optimization",
      title: "Review usage burn and optimize",
      rationale: `${sources.usage.totals.totalTokens.toLocaleString()} tokens and $${sources.usage.totals.totalCost.toFixed(2)} used in the selected window.`,
      confidence,
      score: calculateActionScore(76, confidence),
      source: "usage",
    });
  }

  if (
    sources.sessions.staleSessions > Math.max(5, Math.floor(sources.sessions.totalSessions * 0.6))
  ) {
    const confidence = normalizeConfidence(sourceConfidence(sources.sessions.status));
    candidates.push({
      id: "sessions-hygiene",
      title: "Clean up stale sessions",
      rationale: `${sources.sessions.staleSessions} stale sessions out of ${sources.sessions.totalSessions} total.`,
      confidence,
      score: calculateActionScore(68, confidence),
      source: "sessions",
    });
  }

  const unavailableSources = [
    ["sessions", sources.sessions.status],
    ["usage", sources.usage.status],
    ["orchestrator", sources.orchestrator.status],
    ["cron", sources.cron.status],
    ["messaging", sources.messaging.status],
  ]
    .filter(([, status]) => status !== "ok")
    .map(([name]) => name);

  if (unavailableSources.length > 0) {
    const confidence = normalizeConfidence(0.55);
    candidates.push({
      id: "restore-telemetry",
      title: "Restore missing telemetry",
      rationale: `Brief quality is degraded because these sources are partial/unavailable: ${unavailableSources.join(", ")}.`,
      confidence,
      score: calculateActionScore(72, confidence),
      source: "system",
    });
  }

  const defaults: ExecutiveBriefAction[] = [
    {
      id: "default-priorities",
      title: "Confirm top priorities for this block",
      rationale: "No severe incidents detected. Use this window to align priorities and deadlines.",
      confidence: 0.45,
      score: 50,
      source: "system",
    },
    {
      id: "default-monitoring",
      title: "Keep channel and cron monitoring active",
      rationale:
        "System health looks stable; continue watching for drift in channel and scheduler status.",
      confidence: 0.4,
      score: 45,
      source: "system",
    },
    {
      id: "default-usage",
      title: "Track usage trend through the day",
      rationale:
        "Maintain predictable spend by checking token and cost trajectory at the next checkpoint.",
      confidence: 0.38,
      score: 42,
      source: "system",
    },
  ];

  const ranked = [...candidates]
    .toSorted((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, limit);

  if (ranked.length < limit) {
    for (const item of defaults) {
      if (ranked.length >= limit) {
        break;
      }
      if (!ranked.find((existing) => existing.id === item.id)) {
        ranked.push(item);
      }
    }
  }

  return ranked;
}

export async function buildExecutiveBriefPayload(
  params: BuildExecutiveBriefParams,
): Promise<ExecutiveBriefPayload> {
  const preset = resolvePreset(params.preset);
  const windows = resolveWindows(preset, params.windows);

  const sources = createFallbackSources();
  sources.sessions = await collectSessionsSource(windows);
  sources.usage = await collectUsageSource(windows);
  sources.orchestrator = await collectOrchestratorSource(windows);
  sources.cron = await collectCronSource(params.context, windows);
  sources.messaging = collectMessagingSource(params.context, windows);

  return {
    generatedAt: Date.now(),
    preset,
    windows,
    degraded: Object.values(sources).some((source) => source.status !== "ok"),
    warnings: uniqueWarnings(sources),
    topActions: rankExecutiveBriefActions(sources, {
      topActionsLimit: params.topActionsLimit,
    }),
    sources,
  };
}

export const __test = {
  resolvePreset,
  resolveWindows,
  calculateActionScore,
};
