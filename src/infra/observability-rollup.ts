import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEventsLogDir,
  resolveEventsLogPathForDay,
  resolveStateDir,
} from "../config/paths.js";
import { DEFAULT_LOG_DIR } from "../logging/logger.js";
import type { ObservabilityEventEnvelope } from "../logging/observability.js";

const DEFAULT_EVENTS_STALE_MS = 60 * 60 * 1000;

export type ObservabilityFileStatus = {
  path: string;
  exists: boolean;
  updatedAtMs: number | null;
  ageMs: number | null;
  sizeBytes: number | null;
};

export type ObservabilityFreshnessStatus = {
  level: "ok" | "warn";
  summary: string;
  gatewayLog: ObservabilityFileStatus;
  eventsFile: ObservabilityFileStatus;
  warnings: string[];
  maxStaleMs: number;
};

export type DailyObservabilityRollup = {
  schema: "openclaw.observability.daily-rollup.v1";
  day: string;
  timeZone: string;
  generatedAt: string;
  source: {
    eventsFile: string;
    exists: boolean;
    totalLines: number;
    parsedEvents: number;
    malformedLines: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
  };
  totals: {
    events: number;
    byType: Record<string, number>;
    byComponent: Record<string, number>;
    byStatus: Record<string, number>;
  };
  channels: Record<
    string,
    {
      webhooksReceived: number;
      webhooksProcessed: number;
      webhookErrors: number;
      messagesQueued: number;
      messagesCompleted: number;
      messagesSkipped: number;
      messagesErrored: number;
      modelRuns: number;
    }
  >;
  modelUsage: {
    runs: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
    costUsd: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    byChannel: Record<string, number>;
  };
  runtime: {
    modelResolutions: {
      total: number;
      byResolution: Record<string, number>;
    };
    modelRequests: number;
    modelResults: {
      ok: number;
      error: number;
      avgDurationMs: number | null;
      p95DurationMs: number | null;
    };
    tools: {
      starts: number;
      results: number;
      errors: number;
      byTool: Record<string, number>;
    };
    skills: {
      prepare: number;
      start: number;
      ok: number;
      error: number;
    };
    subagents: {
      registered: number;
      spawnFailed: number;
      waitStarted: number;
      waitOk: number;
      waitError: number;
      waitTimeout: number;
    };
  };
  queues: {
    byLane: Record<
      string,
      {
        enqueued: number;
        dequeued: number;
        maxQueueSize: number;
        avgWaitMs: number | null;
        p95WaitMs: number | null;
      }
    >;
  };
  sessions: {
    uniqueSessions: number;
    states: Record<string, number>;
    stuckEvents: number;
    maxStuckAgeMs: number | null;
    toolLoopWarnings: number;
    toolLoopCritical: number;
  };
  warnings: string[];
};

type RollupEvent = ObservabilityEventEnvelope;

type MutableLaneSummary = DailyObservabilityRollup["queues"]["byLane"][string] & {
  waitMsValues?: number[];
};

function resolveTimeZone(timeZone?: string): string {
  return timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatDayKey(date: Date, timeZone?: string): string {
  return date.toLocaleDateString("en-CA", { timeZone: resolveTimeZone(timeZone) });
}

function formatLocalGatewayLogDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveObservabilityRollupDir(params?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  const env = params?.env ?? process.env;
  const stateDir = params?.stateDir ?? resolveStateDir(env);
  return path.join(resolveEventsLogDir(env, stateDir), "daily");
}

export function resolveObservabilityRollupFilePath(params: {
  day: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return path.join(resolveObservabilityRollupDir(params), `${params.day}.json`);
}

export function resolveGatewayLogFilePath(cfg?: OpenClawConfig, now: Date = new Date()): string {
  const configured = cfg?.logging?.file?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(DEFAULT_LOG_DIR, `openclaw-${formatLocalGatewayLogDay(now)}.log`);
}

async function getFileStatus(filePath: string, nowMs: number): Promise<ObservabilityFileStatus> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return {
        path: filePath,
        exists: false,
        updatedAtMs: null,
        ageMs: null,
        sizeBytes: null,
      };
    }
    return {
      path: filePath,
      exists: true,
      updatedAtMs: stat.mtimeMs,
      ageMs: Math.max(0, nowMs - stat.mtimeMs),
      sizeBytes: stat.size,
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      updatedAtMs: null,
      ageMs: null,
      sizeBytes: null,
    };
  }
}

export async function inspectObservabilityFreshness(params?: {
  cfg?: OpenClawConfig;
  nowMs?: number;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  gatewayLogPath?: string;
  eventsFilePath?: string;
  day?: string;
  maxStaleMs?: number;
}): Promise<ObservabilityFreshnessStatus> {
  const env = params?.env ?? process.env;
  const nowMs = params?.nowMs ?? Date.now();
  const day = params?.day ?? formatDayKey(new Date(nowMs));
  const gatewayLogPath =
    params?.gatewayLogPath ?? resolveGatewayLogFilePath(params?.cfg, new Date(nowMs));
  const eventsFilePath =
    params?.eventsFilePath ??
    resolveEventsLogPathForDay(day, env, params?.stateDir ?? resolveStateDir(env));
  const maxStaleMs = params?.maxStaleMs ?? DEFAULT_EVENTS_STALE_MS;

  const [gatewayLog, eventsFile] = await Promise.all([
    getFileStatus(gatewayLogPath, nowMs),
    getFileStatus(eventsFilePath, nowMs),
  ]);

  const warnings: string[] = [];

  if (gatewayLog.exists && !eventsFile.exists) {
    warnings.push(
      `Gateway log is updating, but the observability event sink for ${day} is missing at ${eventsFile.path}. Daily rollups read ${day}.ndjson from logs/events.`,
    );
  }
  if (eventsFile.exists && (eventsFile.ageMs ?? Number.POSITIVE_INFINITY) > maxStaleMs) {
    warnings.push(
      `Observability event sink is stale (last update ${Math.round((eventsFile.ageMs ?? 0) / 60000)}m ago).`,
    );
  }
  if (
    gatewayLog.exists &&
    eventsFile.exists &&
    gatewayLog.updatedAtMs !== null &&
    eventsFile.updatedAtMs !== null &&
    gatewayLog.updatedAtMs - eventsFile.updatedAtMs > maxStaleMs
  ) {
    warnings.push(
      "Gateway log is newer than the daily observability event sink by more than the allowed staleness window.",
    );
  }
  if (!gatewayLog.exists && !eventsFile.exists) {
    warnings.push(
      "Neither the gateway file log nor the daily observability event sink exists yet. If the gateway is idle this can be normal, otherwise check logging startup.",
    );
  }

  return {
    level: warnings.length > 0 ? "warn" : "ok",
    summary:
      warnings.length > 0
        ? "Observability event files are missing or stale."
        : "Observability event files look fresh.",
    gatewayLog,
    eventsFile,
    warnings,
    maxStaleMs,
  };
}

function safeParseObservabilityEvent(line: string): RollupEvent | null {
  try {
    const parsed = JSON.parse(line) as Partial<RollupEvent> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.event !== "string" || typeof parsed.component !== "string") {
      return null;
    }
    if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) {
      return null;
    }
    return parsed as RollupEvent;
  } catch {
    return null;
  }
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.max(0, Math.ceil(sortedValues.length * p) - 1);
  return sortedValues[index] ?? sortedValues[sortedValues.length - 1] ?? null;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getDataRecord(event: RollupEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureChannel(
  channels: DailyObservabilityRollup["channels"],
  channel: string,
): DailyObservabilityRollup["channels"][string] {
  return (channels[channel] ??= {
    webhooksReceived: 0,
    webhooksProcessed: 0,
    webhookErrors: 0,
    messagesQueued: 0,
    messagesCompleted: 0,
    messagesSkipped: 0,
    messagesErrored: 0,
    modelRuns: 0,
  });
}

function ensureLane(
  lanes: DailyObservabilityRollup["queues"]["byLane"],
  lane: string,
): MutableLaneSummary {
  const existing = lanes[lane] as MutableLaneSummary | undefined;
  if (existing) {
    existing.waitMsValues ??= [];
    return existing;
  }
  const created: MutableLaneSummary = {
    enqueued: 0,
    dequeued: 0,
    maxQueueSize: 0,
    avgWaitMs: null,
    p95WaitMs: null,
    waitMsValues: [],
  };
  lanes[lane] = created;
  return created;
}

export async function buildDailyObservabilityRollup(params?: {
  day?: string;
  timeZone?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  eventsFilePath?: string;
  nowMs?: number;
}): Promise<DailyObservabilityRollup> {
  const nowMs = params?.nowMs ?? Date.now();
  const timeZone = resolveTimeZone(params?.timeZone);
  const day = params?.day ?? formatDayKey(new Date(nowMs), timeZone);
  const env = params?.env ?? process.env;
  const stateDir = params?.stateDir ?? resolveStateDir(env);
  const eventsFilePath = params?.eventsFilePath ?? resolveEventsLogPathForDay(day, env, stateDir);

  const rollup: DailyObservabilityRollup = {
    schema: "openclaw.observability.daily-rollup.v1",
    day,
    timeZone,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      eventsFile: eventsFilePath,
      exists: false,
      totalLines: 0,
      parsedEvents: 0,
      malformedLines: 0,
      firstEventAt: null,
      lastEventAt: null,
    },
    totals: {
      events: 0,
      byType: {},
      byComponent: {},
      byStatus: {},
    },
    channels: {},
    modelUsage: {
      runs: 0,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      costUsd: 0,
      avgDurationMs: null,
      p95DurationMs: null,
      byProvider: {},
      byModel: {},
      byChannel: {},
    },
    runtime: {
      modelResolutions: {
        total: 0,
        byResolution: {},
      },
      modelRequests: 0,
      modelResults: {
        ok: 0,
        error: 0,
        avgDurationMs: null,
        p95DurationMs: null,
      },
      tools: {
        starts: 0,
        results: 0,
        errors: 0,
        byTool: {},
      },
      skills: {
        prepare: 0,
        start: 0,
        ok: 0,
        error: 0,
      },
      subagents: {
        registered: 0,
        spawnFailed: 0,
        waitStarted: 0,
        waitOk: 0,
        waitError: 0,
        waitTimeout: 0,
      },
    },
    queues: {
      byLane: {},
    },
    sessions: {
      uniqueSessions: 0,
      states: {},
      stuckEvents: 0,
      maxStuckAgeMs: null,
      toolLoopWarnings: 0,
      toolLoopCritical: 0,
    },
    warnings: [],
  };

  const seenSessions = new Set<string>();
  const usageDurations: number[] = [];
  const modelResultDurations: number[] = [];
  let firstEventTs: number | null = null;
  let lastEventTs: number | null = null;

  if (!fs.existsSync(eventsFilePath)) {
    rollup.warnings.push(
      `Observability event sink missing at ${eventsFilePath}. This baseline expects one NDJSON file per day under logs/events.`,
    );
    return rollup;
  }

  rollup.source.exists = true;

  const stream = fs.createReadStream(eventsFilePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    rollup.source.totalLines += 1;
    const event = safeParseObservabilityEvent(line);
    if (!event) {
      rollup.source.malformedLines += 1;
      continue;
    }

    const tsMs = Date.parse(event.ts);
    const data = getDataRecord(event);
    rollup.source.parsedEvents += 1;
    rollup.totals.events += 1;
    rollup.totals.byType[event.event] = (rollup.totals.byType[event.event] ?? 0) + 1;
    rollup.totals.byComponent[event.component] =
      (rollup.totals.byComponent[event.component] ?? 0) + 1;
    if (event.status) {
      rollup.totals.byStatus[event.status] = (rollup.totals.byStatus[event.status] ?? 0) + 1;
    }
    firstEventTs = firstEventTs === null ? tsMs : Math.min(firstEventTs, tsMs);
    lastEventTs = lastEventTs === null ? tsMs : Math.max(lastEventTs, tsMs);

    const sessionRef =
      event.sessionKey ??
      readString(data.sessionId) ??
      readString(data.sessionKey) ??
      readString(data.childSessionKey) ??
      null;
    if (sessionRef) {
      seenSessions.add(sessionRef);
    }

    const channel = readString(data.channel);

    switch (event.event) {
      case "webhook.received": {
        if (channel) {
          ensureChannel(rollup.channels, channel).webhooksReceived += 1;
        }
        break;
      }
      case "webhook.processed": {
        if (channel) {
          ensureChannel(rollup.channels, channel).webhooksProcessed += 1;
        }
        break;
      }
      case "webhook.error": {
        if (channel) {
          ensureChannel(rollup.channels, channel).webhookErrors += 1;
        }
        break;
      }
      case "message.queued": {
        if (channel) {
          ensureChannel(rollup.channels, channel).messagesQueued += 1;
        }
        break;
      }
      case "message.processed": {
        if (channel) {
          const summary = ensureChannel(rollup.channels, channel);
          const outcome = readString(data.outcome);
          if (outcome === "completed") {
            summary.messagesCompleted += 1;
          } else if (outcome === "skipped") {
            summary.messagesSkipped += 1;
          } else {
            summary.messagesErrored += 1;
          }
        }
        break;
      }
      case "model.usage": {
        rollup.modelUsage.runs += 1;
        const usage = data.usage as Record<string, unknown> | undefined;
        rollup.modelUsage.tokens.input += readNumber(usage?.input) ?? 0;
        rollup.modelUsage.tokens.output += readNumber(usage?.output) ?? 0;
        rollup.modelUsage.tokens.cacheRead += readNumber(usage?.cacheRead) ?? 0;
        rollup.modelUsage.tokens.cacheWrite += readNumber(usage?.cacheWrite) ?? 0;
        rollup.modelUsage.tokens.total += readNumber(usage?.total) ?? 0;
        rollup.modelUsage.costUsd += readNumber(data.costUsd) ?? 0;
        const durationMs = readNumber(event.durationMs);
        if (durationMs !== undefined) {
          usageDurations.push(durationMs);
        }
        const provider = readString(data.provider);
        const model = readString(data.model);
        if (provider) {
          rollup.modelUsage.byProvider[provider] =
            (rollup.modelUsage.byProvider[provider] ?? 0) + 1;
        }
        if (model) {
          rollup.modelUsage.byModel[model] = (rollup.modelUsage.byModel[model] ?? 0) + 1;
        }
        if (channel) {
          rollup.modelUsage.byChannel[channel] = (rollup.modelUsage.byChannel[channel] ?? 0) + 1;
          ensureChannel(rollup.channels, channel).modelRuns += 1;
        }
        break;
      }
      case "model.resolve": {
        rollup.runtime.modelResolutions.total += 1;
        const resolution = readString(data.resolution) ?? event.status ?? "unknown";
        rollup.runtime.modelResolutions.byResolution[resolution] =
          (rollup.runtime.modelResolutions.byResolution[resolution] ?? 0) + 1;
        break;
      }
      case "model.request": {
        rollup.runtime.modelRequests += 1;
        break;
      }
      case "model.result": {
        const status = readString(data.status) ?? event.status ?? "unknown";
        if (status === "ok") {
          rollup.runtime.modelResults.ok += 1;
        } else {
          rollup.runtime.modelResults.error += 1;
        }
        const durationMs = readNumber(event.durationMs);
        if (durationMs !== undefined) {
          modelResultDurations.push(durationMs);
        }
        break;
      }
      case "tool.call": {
        const toolName = readString(data.toolName) ?? "unknown";
        rollup.runtime.tools.byTool[toolName] = (rollup.runtime.tools.byTool[toolName] ?? 0) + 1;
        const phase = readString(data.phase);
        const status = readString(data.status) ?? event.status;
        if (phase === "start") {
          rollup.runtime.tools.starts += 1;
        }
        if (phase === "result") {
          rollup.runtime.tools.results += 1;
        }
        if (status === "error") {
          rollup.runtime.tools.errors += 1;
        }
        break;
      }
      case "skill.execution": {
        const phase = readString(data.phase);
        const status = readString(data.status) ?? event.status;
        if (phase === "prepare") {
          rollup.runtime.skills.prepare += 1;
        }
        if (phase === "start") {
          rollup.runtime.skills.start += 1;
        }
        if (status === "ok") {
          rollup.runtime.skills.ok += 1;
        }
        if (status === "error") {
          rollup.runtime.skills.error += 1;
        }
        break;
      }
      case "subagent.lifecycle": {
        const phase = readString(data.phase);
        const status = readString(data.status) ?? event.status;
        if (phase === "registered") {
          rollup.runtime.subagents.registered += 1;
        } else if (phase === "spawn_failed") {
          rollup.runtime.subagents.spawnFailed += 1;
        } else if (phase === "wait_started") {
          rollup.runtime.subagents.waitStarted += 1;
        } else if (phase === "wait_result") {
          if (status === "ok") {
            rollup.runtime.subagents.waitOk += 1;
          } else if (status === "timeout") {
            rollup.runtime.subagents.waitTimeout += 1;
          } else {
            rollup.runtime.subagents.waitError += 1;
          }
        }
        break;
      }
      case "session.state": {
        const state = readString(data.state);
        if (state) {
          rollup.sessions.states[state] = (rollup.sessions.states[state] ?? 0) + 1;
        }
        break;
      }
      case "session.stuck": {
        rollup.sessions.stuckEvents += 1;
        const ageMs = readNumber(data.ageMs);
        if (ageMs !== undefined) {
          rollup.sessions.maxStuckAgeMs = Math.max(rollup.sessions.maxStuckAgeMs ?? 0, ageMs);
        }
        break;
      }
      case "queue.lane.enqueue": {
        const laneName = readString(data.lane);
        const queueSize = readNumber(data.queueSize);
        if (laneName) {
          const lane = ensureLane(rollup.queues.byLane, laneName);
          lane.enqueued += 1;
          lane.maxQueueSize = Math.max(lane.maxQueueSize, queueSize ?? 0);
        }
        break;
      }
      case "queue.lane.dequeue": {
        const laneName = readString(data.lane);
        const queueSize = readNumber(data.queueSize);
        const waitMs = readNumber(data.waitMs);
        if (laneName) {
          const lane = ensureLane(rollup.queues.byLane, laneName);
          lane.dequeued += 1;
          lane.maxQueueSize = Math.max(lane.maxQueueSize, queueSize ?? 0);
          if (waitMs !== undefined) {
            lane.waitMsValues?.push(waitMs);
          }
        }
        break;
      }
      case "tool.loop": {
        const level = readString(data.level) ?? event.status;
        if (level === "critical") {
          rollup.sessions.toolLoopCritical += 1;
        } else {
          rollup.sessions.toolLoopWarnings += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  rollup.source.firstEventAt = firstEventTs === null ? null : new Date(firstEventTs).toISOString();
  rollup.source.lastEventAt = lastEventTs === null ? null : new Date(lastEventTs).toISOString();
  rollup.sessions.uniqueSessions = seenSessions.size;

  const sortedUsageDurations = usageDurations.toSorted((a, b) => a - b);
  rollup.modelUsage.avgDurationMs = average(sortedUsageDurations);
  rollup.modelUsage.p95DurationMs = percentile(sortedUsageDurations, 0.95);

  const sortedModelResultDurations = modelResultDurations.toSorted((a, b) => a - b);
  rollup.runtime.modelResults.avgDurationMs = average(sortedModelResultDurations);
  rollup.runtime.modelResults.p95DurationMs = percentile(sortedModelResultDurations, 0.95);

  for (const [laneName, lane] of Object.entries(rollup.queues.byLane)) {
    const sortedWaits = (lane as MutableLaneSummary).waitMsValues?.toSorted((a, b) => a - b) ?? [];
    lane.avgWaitMs = average(sortedWaits);
    lane.p95WaitMs = percentile(sortedWaits, 0.95);
    delete (lane as MutableLaneSummary).waitMsValues;
    rollup.queues.byLane[laneName] = lane;
  }

  if (rollup.source.malformedLines > 0) {
    rollup.warnings.push(
      `Skipped ${rollup.source.malformedLines} malformed NDJSON line${
        rollup.source.malformedLines === 1 ? "" : "s"
      }.`,
    );
  }
  if (rollup.totals.events === 0) {
    rollup.warnings.push(`No observability events found in ${path.basename(eventsFilePath)}.`);
  }

  return rollup;
}

export async function writeDailyObservabilityRollup(params: {
  rollup: DailyObservabilityRollup;
  outputPath: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fsp.writeFile(params.outputPath, `${JSON.stringify(params.rollup, null, 2)}\n`, "utf8");
}
