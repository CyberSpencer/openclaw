import type { CostUsageTotals } from "../infra/session-cost-usage.js";

export type ExecutiveBriefPreset = "am" | "pm";

export type ExecutiveBriefWindows = {
  sessionsMinutes: number;
  usageMinutes: number;
  orchestratorMinutes: number;
  cronMinutes: number;
  messagingMinutes: number;
};

export type ExecutiveBriefAction = {
  id: string;
  title: string;
  rationale: string;
  confidence: number;
  score: number;
  source: "sessions" | "usage" | "orchestrator" | "cron" | "messaging" | "system";
};

export type ExecutiveBriefSourceStatus = "ok" | "partial" | "unavailable";

export type ExecutiveBriefSourceMeta = {
  status: ExecutiveBriefSourceStatus;
  warnings: string[];
};

export type ExecutiveBriefSources = {
  sessions: ExecutiveBriefSourceMeta & {
    totalSessions: number;
    activeSessions: number;
    staleSessions: number;
    latestUpdatedAt?: number;
  };
  usage: ExecutiveBriefSourceMeta & {
    totals: CostUsageTotals;
    activeAgents: number;
    dailyEntries: number;
  };
  orchestrator: ExecutiveBriefSourceMeta & {
    boards: number;
    runningCards: number;
    reviewCards: number;
    failedCards: number;
    backlogCards: number;
  };
  cron: ExecutiveBriefSourceMeta & {
    enabled: boolean;
    totalJobs: number;
    enabledJobs: number;
    runningJobs: number;
    failingJobs: number;
    dueSoonJobs: number;
    overdueJobs: number;
  };
  messaging: ExecutiveBriefSourceMeta & {
    totalAccounts: number;
    runningAccounts: number;
    connectedAccounts: number;
    errorAccounts: number;
    staleAccounts: number;
  };
};

export type ExecutiveBriefPayload = {
  generatedAt: number;
  preset: ExecutiveBriefPreset;
  windows: ExecutiveBriefWindows;
  degraded: boolean;
  warnings: string[];
  topActions: ExecutiveBriefAction[];
  sources: ExecutiveBriefSources;
};

export const DEFAULT_BRIEF_WINDOWS: Record<ExecutiveBriefPreset, ExecutiveBriefWindows> = {
  am: {
    sessionsMinutes: 12 * 60,
    usageMinutes: 24 * 60,
    orchestratorMinutes: 24 * 60,
    cronMinutes: 12 * 60,
    messagingMinutes: 12 * 60,
  },
  pm: {
    sessionsMinutes: 8 * 60,
    usageMinutes: 12 * 60,
    orchestratorMinutes: 12 * 60,
    cronMinutes: 8 * 60,
    messagingMinutes: 8 * 60,
  },
};

export const EMPTY_TOTALS = (): CostUsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
});
