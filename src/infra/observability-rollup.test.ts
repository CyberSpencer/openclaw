import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEventsLogPathForDay } from "../config/paths.js";
import {
  buildDailyObservabilityRollup,
  inspectObservabilityFreshness,
  resolveObservabilityRollupFilePath,
  writeDailyObservabilityRollup,
} from "./observability-rollup.js";

async function makeTempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-observability-"));
}

function envelope(params: {
  ts: string;
  event: string;
  component?: string;
  status?: string;
  sessionKey?: string;
  durationMs?: number;
  error?: string;
  data?: Record<string, unknown>;
}) {
  return JSON.stringify({
    component: params.component ?? "diagnostic",
    ...params,
  });
}

describe("observability rollup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("builds a daily rollup from canonical observability envelopes", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const eventsFile = resolveEventsLogPathForDay(
      "2026-03-24",
      { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      root,
    );
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    await fs.writeFile(
      eventsFile,
      [
        envelope({
          ts: "2026-03-24T13:00:00.000Z",
          event: "webhook.received",
          data: { seq: 1, channel: "telegram" },
        }),
        envelope({
          ts: "2026-03-24T13:01:00.000Z",
          event: "message.processed",
          sessionKey: "agent:main:telegram:sess-1",
          status: "completed",
          durationMs: 150,
          data: { seq: 2, channel: "telegram", outcome: "completed", sessionId: "sess-1" },
        }),
        envelope({
          ts: "2026-03-24T13:02:00.000Z",
          event: "model.usage",
          sessionKey: "agent:main:telegram:sess-1",
          status: "ok",
          durationMs: 450,
          data: {
            seq: 3,
            channel: "telegram",
            provider: "anthropic",
            model: "claude-sonnet",
            usage: { input: 10, output: 5, total: 15 },
            costUsd: 0.12,
          },
        }),
        envelope({
          ts: "2026-03-24T13:03:00.000Z",
          event: "model.resolve",
          status: "registry",
          data: { seq: 4, resolution: "registry", provider: "anthropic" },
        }),
        envelope({
          ts: "2026-03-24T13:03:30.000Z",
          event: "model.request",
          data: { seq: 5, provider: "anthropic", model: "claude-sonnet", requestIndex: 1 },
        }),
        envelope({
          ts: "2026-03-24T13:03:40.000Z",
          event: "model.result",
          status: "ok",
          durationMs: 420,
          data: { seq: 6, status: "ok", requestIndex: 1 },
        }),
        envelope({
          ts: "2026-03-24T13:04:00.000Z",
          event: "tool.call",
          status: "start",
          data: { seq: 7, toolName: "read", phase: "start" },
        }),
        envelope({
          ts: "2026-03-24T13:04:10.000Z",
          event: "tool.call",
          status: "ok",
          durationMs: 80,
          data: { seq: 8, toolName: "read", phase: "result", status: "ok" },
        }),
        envelope({
          ts: "2026-03-24T13:04:20.000Z",
          event: "skill.execution",
          status: "ok",
          data: { seq: 9, source: "workspace", phase: "prepare", status: "ok" },
        }),
        envelope({
          ts: "2026-03-24T13:04:30.000Z",
          event: "subagent.lifecycle",
          status: "ok",
          data: { seq: 10, phase: "registered", childSessionKey: "agent:worker:child" },
        }),
        envelope({
          ts: "2026-03-24T13:05:00.000Z",
          event: "queue.lane.dequeue",
          data: { seq: 11, lane: "default", queueSize: 2, waitMs: 320 },
        }),
        envelope({
          ts: "2026-03-24T13:06:00.000Z",
          event: "session.stuck",
          status: "warning",
          sessionKey: "agent:main:telegram:sess-1",
          data: { seq: 12, state: "processing", ageMs: 9000 },
        }),
        envelope({
          ts: "2026-03-24T13:07:00.000Z",
          event: "tool.loop",
          status: "warning",
          sessionKey: "agent:main:telegram:sess-1",
          data: { seq: 13, toolName: "read", level: "warning", action: "warn", count: 3 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const rollup = await buildDailyObservabilityRollup({
      stateDir: root,
      day: "2026-03-24",
      timeZone: "UTC",
    });

    expect(rollup.source.exists).toBe(true);
    expect(rollup.totals.events).toBe(13);
    expect(rollup.totals.byType["webhook.received"]).toBe(1);
    expect(rollup.totals.byComponent.diagnostic).toBe(13);
    expect(rollup.channels.telegram?.webhooksReceived).toBe(1);
    expect(rollup.channels.telegram?.messagesCompleted).toBe(1);
    expect(rollup.channels.telegram?.modelRuns).toBe(1);
    expect(rollup.modelUsage.runs).toBe(1);
    expect(rollup.modelUsage.tokens.total).toBe(15);
    expect(rollup.modelUsage.byProvider.anthropic).toBe(1);
    expect(rollup.runtime.modelResolutions.byResolution.registry).toBe(1);
    expect(rollup.runtime.modelRequests).toBe(1);
    expect(rollup.runtime.modelResults.ok).toBe(1);
    expect(rollup.runtime.tools.starts).toBe(1);
    expect(rollup.runtime.tools.results).toBe(1);
    expect(rollup.runtime.tools.byTool.read).toBe(2);
    expect(rollup.runtime.skills.prepare).toBe(1);
    expect(rollup.runtime.subagents.registered).toBe(1);
    expect(rollup.queues.byLane.default?.dequeued).toBe(1);
    expect(rollup.queues.byLane.default?.avgWaitMs).toBe(320);
    expect(rollup.sessions.uniqueSessions).toBe(2);
    expect(rollup.sessions.stuckEvents).toBe(1);
    expect(rollup.sessions.toolLoopWarnings).toBe(1);
  });

  it("returns a warning-only skeleton when the sink is missing", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    const rollup = await buildDailyObservabilityRollup({
      stateDir: root,
      day: "2026-03-24",
      timeZone: "UTC",
    });

    expect(rollup.source.exists).toBe(false);
    expect(rollup.totals.events).toBe(0);
    expect(rollup.warnings[0]).toContain("Observability event sink missing");
  });

  it("reports malformed lines and can write the rollup file", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const eventsFile = resolveEventsLogPathForDay(
      "2026-03-24",
      { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      root,
    );
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    await fs.writeFile(
      eventsFile,
      [
        "{bad json",
        envelope({
          ts: "2026-03-24T13:00:00.000Z",
          event: "diagnostic.heartbeat",
          data: { seq: 1, webhooks: { received: 1, processed: 1, errors: 0 }, active: 0 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const rollup = await buildDailyObservabilityRollup({
      stateDir: root,
      day: "2026-03-24",
      timeZone: "UTC",
    });
    const outputPath = resolveObservabilityRollupFilePath({
      day: "2026-03-24",
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    await writeDailyObservabilityRollup({ rollup, outputPath });

    expect(rollup.source.malformedLines).toBe(1);
    expect(rollup.warnings.some((warning) => warning.includes("Skipped 1 malformed"))).toBe(true);
    const written = JSON.parse(await fs.readFile(outputPath, "utf8")) as { day: string };
    expect(written.day).toBe("2026-03-24");
  });
});

describe("observability freshness", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("warns when the gateway log is fresher than the event sink", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const gatewayLog = path.join(root, "gateway.log");
    const eventsFile = resolveEventsLogPathForDay(
      "2026-03-24",
      { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      root,
    );
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    await fs.writeFile(gatewayLog, "gateway\n", "utf8");
    await fs.writeFile(eventsFile, "{}\n", "utf8");

    const nowMs = Date.parse("2026-03-24T14:00:00.000Z");
    await fs.utimes(gatewayLog, nowMs / 1000, nowMs / 1000);
    await fs.utimes(
      eventsFile,
      (nowMs - 2 * 60 * 60 * 1000) / 1000,
      (nowMs - 2 * 60 * 60 * 1000) / 1000,
    );

    const freshness = await inspectObservabilityFreshness({
      gatewayLogPath: gatewayLog,
      eventsFilePath: eventsFile,
      nowMs,
      maxStaleMs: 30 * 60 * 1000,
    });

    expect(freshness.level).toBe("warn");
    expect(freshness.warnings.join("\n")).toContain(
      "newer than the daily observability event sink",
    );
  });

  it("returns ok when both files are fresh", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const gatewayLog = path.join(root, "gateway.log");
    const eventsFile = resolveEventsLogPathForDay(
      "2026-03-24",
      { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      root,
    );
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    await fs.writeFile(gatewayLog, "gateway\n", "utf8");
    await fs.writeFile(eventsFile, "{}\n", "utf8");

    const nowMs = Date.parse("2026-03-24T14:00:00.000Z");
    await fs.utimes(gatewayLog, nowMs / 1000, nowMs / 1000);
    await fs.utimes(eventsFile, (nowMs - 5 * 60 * 1000) / 1000, (nowMs - 5 * 60 * 1000) / 1000);

    const freshness = await inspectObservabilityFreshness({
      gatewayLogPath: gatewayLog,
      eventsFilePath: eventsFile,
      nowMs,
      maxStaleMs: 30 * 60 * 1000,
    });

    expect(freshness.level).toBe("ok");
    expect(freshness.warnings).toEqual([]);
  });
});
