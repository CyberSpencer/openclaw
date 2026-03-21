/**
 * Tests for T-0025: cron failure grounding, cooldown, and operator diagnostics.
 *
 * Validates:
 * - 3 consecutive failures → 15min cooldown applied to nextRunAtMs
 * - 5 consecutive failures → 60min cooldown applied to nextRunAtMs
 * - Failure grounding: repeated identical errors do NOT each fire a system event
 * - Diagnostics: getCronJobFailureDiagnostics / getJobDiagnostics expose streak and cooldown
 * - State resets on success (no spurious cooldowns after recovery)
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService, getCronJobFailureDiagnostics } from "./service.js";

const BASE_NOW = new Date("2026-03-01T00:00:00.000Z").getTime();

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function makeTmpStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-reliability-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe("cron reliability: cooldown and grounding (T-0025)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies 15min cooldown after 3 consecutive failures", async () => {
    const store = await makeTmpStorePath();
    const log = makeLogger();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "provider unavailable",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "reliability-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run task" },
    });

    // Run 3 consecutive failures
    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    await cron.run(job.id, "force");

    const updatedJob = cron.getJob(job.id);
    expect(updatedJob?.state.consecutiveErrors).toBe(3);

    // nextRunAtMs must be at least 15min from now
    const minCooldownEnd = BASE_NOW + 15 * 60_000;
    expect(updatedJob?.state.nextRunAtMs).toBeGreaterThanOrEqual(minCooldownEnd);

    // Diagnostic confirms cooldown is active
    const diag = cron.getJobDiagnostics(job.id);
    expect(diag?.inCooldown).toBe(true);
    expect(diag?.streakBand).toBe(3);
    expect(diag?.consecutiveErrors).toBe(3);

    await store.cleanup();
  });

  it("applies 60min cooldown after 5 consecutive failures", async () => {
    const store = await makeTmpStorePath();
    const log = makeLogger();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "model overloaded",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "reliability-5fail",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run task" },
    });

    // Run 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      await cron.run(job.id, "force");
    }

    const updatedJob = cron.getJob(job.id);
    expect(updatedJob?.state.consecutiveErrors).toBe(5);

    // nextRunAtMs must be at least 60min from now
    const minCooldownEnd = BASE_NOW + 60 * 60_000;
    expect(updatedJob?.state.nextRunAtMs).toBeGreaterThanOrEqual(minCooldownEnd);

    const diag = cron.getJobDiagnostics(job.id);
    expect(diag?.inCooldown).toBe(true);
    expect(diag?.streakBand).toBe(5);
    expect(diag?.consecutiveErrors).toBe(5);

    await store.cleanup();
  });

  it("resets cooldown and grounding state after a successful run", async () => {
    const store = await makeTmpStorePath();
    const log = makeLogger();
    let failCount = 0;
    const runIsolatedAgentJob = vi.fn(async () => {
      failCount++;
      if (failCount <= 3) {
        return { status: "error" as const, error: "transient error" };
      }
      return { status: "ok" as const };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "reliability-recovery",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run task" },
    });

    // 3 failures → cooldown active
    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(cron.getJobDiagnostics(job.id)?.inCooldown).toBe(true);

    // Success → cooldown clears
    await cron.run(job.id, "force");
    const diag = cron.getJobDiagnostics(job.id);
    expect(diag?.inCooldown).toBe(false);
    expect(diag?.consecutiveErrors).toBe(0);
    expect(diag?.streakBand).toBe(0);
    expect(cron.getJob(job.id)?.state.failureCooldownEndsAtMs).toBeUndefined();
    expect(cron.getJob(job.id)?.state.groundedErrorMessage).toBeUndefined();

    await store.cleanup();
  });

  it("grounding: identical failure does not repeatedly fire system events", async () => {
    const store = await makeTmpStorePath();
    const log = makeLogger();
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "auth token expired",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 0, // no time-based cooldown to isolate grounding behavior
        },
      },
      log,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "grounding-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run task" },
      delivery: { mode: "announce", channel: "telegram", to: "u123" },
    });

    // Failures 1–5 all with the same error message
    for (let i = 0; i < 5; i++) {
      await cron.run(job.id, "force");
    }

    // Only the first threshold crossing (at 2 failures) and the band transition
    // (3 → 5) should trigger alerts. The identical intermediate failures must be grounded.
    // failure #2 → band 0→2 (alertConfig.after=2): first alert
    // failure #3 → band 3 (3-threshold): second alert (band escalation)
    // failure #4 → grounded (same band, same error)
    // failure #5 → band 5 (5-threshold): third alert (band escalation)
    expect(sendCronFailureAlert.mock.calls.length).toBeLessThanOrEqual(3);
    // Must be fewer than 5 (demonstrating grounding worked)
    expect(sendCronFailureAlert.mock.calls.length).toBeLessThan(5);

    await store.cleanup();
  });

  it("grounding: different error message re-triggers alert within same band", async () => {
    const store = await makeTmpStorePath();
    const log = makeLogger();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    let callCount = 0;
    const errors = ["auth expired", "auth expired", "model overloaded", "model overloaded"];
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: errors[callCount++] ?? "unknown",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 2,
          cooldownMs: 0,
        },
      },
      log,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      sendCronFailureAlert,
    });

    await cron.start();
    const job = await cron.add({
      name: "error-change-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run task" },
      delivery: { mode: "announce", channel: "telegram", to: "u456" },
    });

    // failure 1: "auth expired"       → no alert yet (< alertConfig.after=2)
    // failure 2: "auth expired"       → first alert (crosses after=2, band=0→3 via threshold)
    // failure 3: "model overloaded"   → alert (error changed)
    // failure 4: "model overloaded"   → grounded (same error, same band)
    for (let i = 0; i < 4; i++) {
      await cron.run(job.id, "force");
    }

    // Error change at failure 3 must have triggered another alert
    expect(sendCronFailureAlert.mock.calls.length).toBeGreaterThanOrEqual(2);

    await store.cleanup();
  });

  it("getCronJobFailureDiagnostics helper works with raw job state", () => {
    const now = BASE_NOW;
    const cooldownEndsAtMs = now + 15 * 60_000;
    const diag = getCronJobFailureDiagnostics(
      {
        consecutiveErrors: 3,
        failureCooldownEndsAtMs: cooldownEndsAtMs,
        lastError: "provider timeout",
      },
      now,
    );

    expect(diag.consecutiveErrors).toBe(3);
    expect(diag.inCooldown).toBe(true);
    expect(diag.streakBand).toBe(3);
    expect(diag.cooldownEndsAtMs).toBe(cooldownEndsAtMs);
    expect(diag.cooldownRemainingMs).toBe(15 * 60_000);
    expect(diag.lastError).toBe("provider timeout");
  });
});
