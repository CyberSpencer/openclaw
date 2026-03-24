import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteObservabilityHealth } from "./doctor-observability.js";

describe("noteObservabilityHealth", () => {
  let root: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    note.mockClear();
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-observability-"));
    process.env.OPENCLAW_STATE_DIR = root;
  });

  afterEach(async () => {
    vi.useRealTimers();
    envSnapshot.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("warns when the event sink is missing", async () => {
    const gatewayLog = path.join(root, "gateway.log");
    await fs.writeFile(gatewayLog, "gateway\n", "utf8");

    await noteObservabilityHealth({
      cfg: { logging: { file: gatewayLog } } as OpenClawConfig,
      maxStaleMs: 30 * 60 * 1000,
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Observability");
    expect(message).toContain("Event sink");
    expect(message).toContain("logs/events");
  });

  it("stays quiet when the files are fresh", async () => {
    const gatewayLog = path.join(root, "gateway.log");
    const eventsFile = path.join(root, "logs", "events", "2026-03-24.ndjson");
    await fs.mkdir(path.dirname(eventsFile), { recursive: true });
    await fs.writeFile(gatewayLog, "gateway\n", "utf8");
    await fs.writeFile(eventsFile, "{}\n", "utf8");

    const nowMs = Date.parse("2026-03-24T14:00:00.000Z");
    await fs.utimes(gatewayLog, nowMs / 1000, nowMs / 1000);
    await fs.utimes(eventsFile, (nowMs - 5 * 60 * 1000) / 1000, (nowMs - 5 * 60 * 1000) / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    await noteObservabilityHealth({
      cfg: { logging: { file: gatewayLog } } as OpenClawConfig,
      maxStaleMs: 30 * 60 * 1000,
    });

    expect(note).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
