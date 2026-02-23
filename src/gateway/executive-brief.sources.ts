import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../cron/types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadCostUsageSummary, type CostUsageTotals } from "../infra/session-cost-usage.js";
import {
  EMPTY_TOTALS,
  type ExecutiveBriefSources,
  type ExecutiveBriefSourceStatus,
  type ExecutiveBriefWindows,
} from "./executive-brief.types.js";
import { listAgentsForGateway, loadCombinedSessionStoreForGateway } from "./session-utils.js";

function sumTotals(target: CostUsageTotals, source: CostUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.missingCostEntries += source.missingCostEntries;
}

function isCronRunSessionKey(key: string): boolean {
  const raw = key.startsWith("agent:") ? key.split(":").slice(2).join(":") : key;
  return /^cron:[^:]+:run:[^:]+$/.test(raw);
}

export function createFallbackSources(): ExecutiveBriefSources {
  return {
    sessions: {
      status: "unavailable",
      warnings: [],
      totalSessions: 0,
      activeSessions: 0,
      staleSessions: 0,
    },
    usage: {
      status: "unavailable",
      warnings: [],
      totals: EMPTY_TOTALS(),
      activeAgents: 0,
      dailyEntries: 0,
    },
    orchestrator: {
      status: "unavailable",
      warnings: [],
      boards: 0,
      runningCards: 0,
      reviewCards: 0,
      failedCards: 0,
      backlogCards: 0,
    },
    cron: {
      status: "unavailable",
      warnings: [],
      enabled: false,
      totalJobs: 0,
      enabledJobs: 0,
      runningJobs: 0,
      failingJobs: 0,
      dueSoonJobs: 0,
      overdueJobs: 0,
    },
    messaging: {
      status: "unavailable",
      warnings: [],
      totalAccounts: 0,
      runningAccounts: 0,
      connectedAccounts: 0,
      errorAccounts: 0,
      staleAccounts: 0,
    },
  };
}

export async function collectSessionsSource(
  windows: ExecutiveBriefWindows,
): Promise<ExecutiveBriefSources["sessions"]> {
  try {
    const cfg = loadConfig();
    const { store } = loadCombinedSessionStoreForGateway(cfg);
    const now = Date.now();
    const cutoffMs = now - windows.sessionsMinutes * 60_000;

    const entries = Object.entries(store).filter(([key]) => {
      if (key === "global" || key === "unknown") {
        return false;
      }
      return !isCronRunSessionKey(key);
    });

    const updatedAts = entries
      .map(([, entry]) => entry.updatedAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const activeSessions = updatedAts.filter((updatedAt) => updatedAt >= cutoffMs).length;
    const totalSessions = entries.length;

    return {
      status: "ok",
      warnings: [],
      totalSessions,
      activeSessions,
      staleSessions: Math.max(0, totalSessions - activeSessions),
      latestUpdatedAt: updatedAts.length ? Math.max(...updatedAts) : undefined,
    };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "unable to read sessions";
    return {
      status: "unavailable",
      warnings: [warning],
      totalSessions: 0,
      activeSessions: 0,
      staleSessions: 0,
    };
  }
}

export async function collectUsageSource(
  windows: ExecutiveBriefWindows,
): Promise<ExecutiveBriefSources["usage"]> {
  try {
    const cfg = loadConfig();
    const now = Date.now();
    const startMs = now - windows.usageMinutes * 60_000;
    const totals = EMPTY_TOTALS();
    const agents = listAgentsForGateway(cfg).agents;
    let activeAgents = 0;
    let dailyEntries = 0;

    const summaries = await Promise.all(
      agents.map((agent) =>
        loadCostUsageSummary({
          startMs,
          endMs: now,
          config: cfg,
          agentId: agent.id,
        }),
      ),
    );

    for (const summary of summaries) {
      sumTotals(totals, summary.totals);
      dailyEntries += summary.daily.length;
      if (summary.totals.totalTokens > 0) {
        activeAgents += 1;
      }
    }

    return {
      status: "ok",
      warnings: [],
      totals,
      activeAgents,
      dailyEntries,
    };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "unable to load usage data";
    return {
      status: "unavailable",
      warnings: [warning],
      totals: EMPTY_TOTALS(),
      activeAgents: 0,
      dailyEntries: 0,
    };
  }
}

type OrchestratorState = {
  version?: number;
  boards?: Array<{
    cards?: Array<{ laneId?: string; updatedAt?: number }>;
  }>;
};

async function readOrchestratorStateFiles(): Promise<OrchestratorState[]> {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const scopedDir = path.join(stateDir, "control-ui", "orchestrator");
  const legacyPath = path.join(stateDir, "control-ui", "orchestrator.json");

  const files: string[] = [];
  try {
    const names = await fs.promises.readdir(scopedDir);
    for (const name of names) {
      if (name.endsWith(".json")) {
        files.push(path.join(scopedDir, name));
      }
    }
  } catch {
    // ignore missing dir
  }
  try {
    await fs.promises.access(legacyPath);
    files.push(legacyPath);
  } catch {
    // ignore missing legacy file
  }

  const states: OrchestratorState[] = [];
  for (const filePath of files) {
    try {
      const raw = (await fs.promises.readFile(filePath, "utf8")).trim();
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as OrchestratorState;
      if (parsed && typeof parsed === "object") {
        states.push(parsed);
      }
    } catch {
      // skip malformed files
    }
  }

  return states;
}

export async function collectOrchestratorSource(
  windows: ExecutiveBriefWindows,
): Promise<ExecutiveBriefSources["orchestrator"]> {
  try {
    const states = await readOrchestratorStateFiles();
    const cutoffMs = Date.now() - windows.orchestratorMinutes * 60_000;

    let boards = 0;
    let runningCards = 0;
    let reviewCards = 0;
    let failedCards = 0;
    let backlogCards = 0;

    for (const state of states) {
      const stateBoards = Array.isArray(state.boards) ? state.boards : [];
      boards += stateBoards.length;
      for (const board of stateBoards) {
        const cards = Array.isArray(board.cards) ? board.cards : [];
        for (const card of cards) {
          const updatedAt = typeof card.updatedAt === "number" ? card.updatedAt : Date.now();
          if (updatedAt < cutoffMs) {
            continue;
          }
          switch ((card.laneId ?? "").toLowerCase()) {
            case "running":
              runningCards += 1;
              break;
            case "review":
              reviewCards += 1;
              break;
            case "failed":
              failedCards += 1;
              break;
            case "backlog":
              backlogCards += 1;
              break;
            default:
              break;
          }
        }
      }
    }

    return {
      status: states.length > 0 ? "ok" : "partial",
      warnings: states.length > 0 ? [] : ["orchestrator state not found"],
      boards,
      runningCards,
      reviewCards,
      failedCards,
      backlogCards,
    };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "unable to load orchestrator state";
    return {
      status: "unavailable",
      warnings: [warning],
      boards: 0,
      runningCards: 0,
      reviewCards: 0,
      failedCards: 0,
      backlogCards: 0,
    };
  }
}

export function countCronMetrics(
  jobs: CronJob[],
  windowMinutes: number,
): ExecutiveBriefSources["cron"] {
  const now = Date.now();
  const dueCutoff = now + windowMinutes * 60_000;

  const enabledJobs = jobs.filter((job) => job.enabled);
  const runningJobs = enabledJobs.filter((job) => typeof job.state.runningAtMs === "number").length;
  const failingJobs = enabledJobs.filter((job) => job.state.lastStatus === "error").length;
  const dueSoonJobs = enabledJobs.filter((job) => {
    const nextRunAtMs = job.state.nextRunAtMs;
    return typeof nextRunAtMs === "number" && nextRunAtMs >= now && nextRunAtMs <= dueCutoff;
  }).length;
  const overdueJobs = enabledJobs.filter((job) => {
    const nextRunAtMs = job.state.nextRunAtMs;
    return typeof nextRunAtMs === "number" && nextRunAtMs < now;
  }).length;

  return {
    status: "ok",
    warnings: [],
    enabled: true,
    totalJobs: jobs.length,
    enabledJobs: enabledJobs.length,
    runningJobs,
    failingJobs,
    dueSoonJobs,
    overdueJobs,
  };
}

export async function collectCronSource(
  context: GatewayRequestContext,
  windows: ExecutiveBriefWindows,
): Promise<ExecutiveBriefSources["cron"]> {
  try {
    const status = await context.cron.status();
    const jobs = await context.cron.list({ includeDisabled: true });
    const counted = countCronMetrics(jobs, windows.cronMinutes);
    return {
      ...counted,
      enabled: status.enabled,
      status: status.enabled ? counted.status : "partial",
      warnings: status.enabled ? counted.warnings : ["cron service disabled"],
    };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "unable to load cron status";
    return {
      status: "unavailable",
      warnings: [warning],
      enabled: false,
      totalJobs: 0,
      enabledJobs: 0,
      runningJobs: 0,
      failingJobs: 0,
      dueSoonJobs: 0,
      overdueJobs: 0,
    };
  }
}

export function collectMessagingSource(
  context: GatewayRequestContext,
  windows: ExecutiveBriefWindows,
): ExecutiveBriefSources["messaging"] {
  try {
    const snapshot = context.getRuntimeSnapshot();
    const now = Date.now();
    const staleCutoff = now - windows.messagingMinutes * 60_000;

    const accounts = Object.values(snapshot.channelAccounts ?? {})
      .flatMap((channelAccounts) => Object.values(channelAccounts ?? {}))
      .filter((account) => account && typeof account === "object");

    const runningAccounts = accounts.filter((account) => account.running === true).length;
    const connectedAccounts = accounts.filter((account) => account.connected === true).length;
    const errorAccounts = accounts.filter((account) => {
      if (typeof account.lastError !== "string") {
        return false;
      }
      return account.lastError.trim().length > 0;
    }).length;

    const staleAccounts = accounts.filter((account) => {
      const lastActivity =
        account.lastInboundAt ??
        account.lastOutboundAt ??
        account.lastEventAt ??
        account.lastConnectedAt;
      return typeof lastActivity === "number" && lastActivity < staleCutoff;
    }).length;

    return {
      status: accounts.length > 0 ? "ok" : "partial",
      warnings: accounts.length > 0 ? [] : ["no channel accounts configured"],
      totalAccounts: accounts.length,
      runningAccounts,
      connectedAccounts,
      errorAccounts,
      staleAccounts,
    };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "unable to load messaging status";
    return {
      status: "unavailable",
      warnings: [warning],
      totalAccounts: 0,
      runningAccounts: 0,
      connectedAccounts: 0,
      errorAccounts: 0,
      staleAccounts: 0,
    };
  }
}

export function uniqueWarnings(sources: ExecutiveBriefSources): string[] {
  return Array.from(
    new Set(
      [
        ...sources.sessions.warnings,
        ...sources.usage.warnings,
        ...sources.orchestrator.warnings,
        ...sources.cron.warnings,
        ...sources.messaging.warnings,
      ].filter((value) => value.trim().length > 0),
    ),
  );
}

export function sourceConfidence(status: ExecutiveBriefSourceStatus): number {
  if (status === "ok") {
    return 0.9;
  }
  if (status === "partial") {
    return 0.65;
  }
  return 0.4;
}
