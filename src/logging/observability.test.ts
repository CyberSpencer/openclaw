import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEventsLogPath } from "../config/paths.js";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  emitObservabilityEvent,
  flushObservabilityForTest,
  resetObservabilityForTest,
  setObservabilityEnabledForTest,
} from "./observability.js";

describe("observability events", () => {
  let envSnapshot: string | undefined;
  let stateDir = "";

  beforeEach(async () => {
    envSnapshot = process.env.OPENCLAW_STATE_DIR;
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-observability-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T15:16:17.000Z"));
    resetDiagnosticEventsForTest();
    resetObservabilityForTest();
    setObservabilityEnabledForTest(true);
  });

  afterEach(async () => {
    resetDiagnosticEventsForTest();
    await flushObservabilityForTest();
    resetObservabilityForTest();
    vi.useRealTimers();
    if (envSnapshot === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = envSnapshot;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("writes canonical observability envelopes to the daily NDJSON sink", async () => {
    const emitted = emitObservabilityEvent({
      event: "agent.run.started",
      component: "agent/runtime",
      sessionKey: "agent:ops:main",
      traceId: "trace-1",
      spanId: "span-1",
      status: "started",
      data: {
        runId: "run-1",
      },
    });
    await flushObservabilityForTest();

    const filePath = resolveEventsLogPath(new Date("2026-03-24T15:16:17.000Z"));
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(emitted.agentId).toBe("ops");
    expect(parsed).toMatchObject({
      ts: "2026-03-24T15:16:17.000Z",
      event: "agent.run.started",
      component: "agent/runtime",
      agentId: "ops",
      sessionKey: "agent:ops:main",
      traceId: "trace-1",
      spanId: "span-1",
      status: "started",
      data: {
        runId: "run-1",
      },
    });
  });

  it("bridges diagnostic events into the observability sink", async () => {
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      sessionKey: "agent:review:main",
      durationMs: 42,
      outcome: "error",
      error: "boom",
    });
    await flushObservabilityForTest();

    const filePath = resolveEventsLogPath(new Date("2026-03-24T15:16:17.000Z"));
    const [line] = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ts: "2026-03-24T15:16:17.000Z",
      event: "message.processed",
      component: "diagnostic",
      agentId: "review",
      sessionKey: "agent:review:main",
      status: "error",
      durationMs: 42,
      error: "boom",
      data: {
        seq: 1,
        channel: "telegram",
        outcome: "error",
      },
    });
  });
});
