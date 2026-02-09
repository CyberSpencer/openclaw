import fs from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-" });
}

async function writeSessionStore(home: string) {
  const dir = path.join(home, ".openclaw", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

function makeCfg(home: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        // Non-empty allowlist so resolveAllowedModelRef can reject stale ids.
        models: {
          "anthropic/claude-opus-4-5": { alias: "default" },
        },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
}

function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
    isolation: { postToMainPrefix: "Cron" },
    name: "Test",
  };
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("clears invalid/disallowed payload.model overrides instead of hard failing", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const job = makeJob({
        kind: "agentTurn",
        message: "do it",
        model: "openai-codex/gpt-5.2",
        deliver: false,
      });
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job,
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(job.payload.kind).toBe("agentTurn");
      expect((job.payload as { model?: string }).model).toBeUndefined();
    });
  });
});
