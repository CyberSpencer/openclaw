import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn(async () => ({
    root: "/tmp/worktree",
    installKind: "git" as const,
    packageManager: "pnpm" as const,
    git: {
      root: "/tmp/worktree",
      sha: "abc123def456",
      tag: null,
      branch: "feature/ops",
      upstream: "origin/feature/ops",
      dirty: false,
      ahead: 0,
      behind: 0,
      fetchOk: null,
    },
    deps: {
      manager: "pnpm" as const,
      status: "ok" as const,
      lockfilePath: "/tmp/worktree/pnpm-lock.yaml",
      markerPath: "/tmp/worktree/node_modules/.modules.yaml",
    },
  })),
}));

import { checkUpdateStatus } from "../../infra/update-check.js";
import { opsHandlers } from "./ops.js";

const noop = () => false;

function buildContext(params: {
  active?: Map<
    string,
    {
      controller: AbortController;
      sessionId: string;
      sessionKey: string;
      startedAtMs: number;
      expiresAtMs: number;
    }
  >;
  deltas?: Map<string, number>;
}) {
  return {
    chatAbortControllers: params.active ?? new Map(),
    chatDeltaSentAt: params.deltas ?? new Map(),
  } as unknown as Parameters<(typeof opsHandlers)["ops.snapshot"]>[0]["context"];
}

describe("ops.snapshot", () => {
  const envBackup = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_NVIDIA_ROUTER_DISABLED: process.env.OPENCLAW_NVIDIA_ROUTER_DISABLED,
    DGX_ENABLED: process.env.DGX_ENABLED,
  };

  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ops-snapshot-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_NVIDIA_ROUTER_DISABLED = "1";
    process.env.DGX_ENABLED = "0";
    vi.mocked(checkUpdateStatus).mockClear();
  });

  afterEach(async () => {
    if (envBackup.OPENCLAW_STATE_DIR == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = envBackup.OPENCLAW_STATE_DIR;
    }
    if (envBackup.OPENCLAW_NVIDIA_ROUTER_DISABLED == null) {
      delete process.env.OPENCLAW_NVIDIA_ROUTER_DISABLED;
    } else {
      process.env.OPENCLAW_NVIDIA_ROUTER_DISABLED = envBackup.OPENCLAW_NVIDIA_ROUTER_DISABLED;
    }
    if (envBackup.DGX_ENABLED == null) {
      delete process.env.DGX_ENABLED;
    } else {
      process.env.DGX_ENABLED = envBackup.DGX_ENABLED;
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns aggregated orchestrator, hygiene, and voice/system snapshot", async () => {
    const orchestratorDir = path.join(tempDir, "control-ui", "orchestrator");
    await fs.mkdir(orchestratorDir, { recursive: true });
    await fs.writeFile(
      path.join(orchestratorDir, "main.json"),
      JSON.stringify({
        version: 1,
        selectedBoardId: "main",
        boards: [
          {
            id: "main",
            title: "Mission Control",
            lanes: [],
            cards: [
              {
                id: "card-running",
                laneId: "running",
                title: "Active run",
                task: "",
                agentId: "main",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                run: {
                  runId: "run-1",
                  sessionKey: "main",
                  status: "running",
                  createdAt: Date.now(),
                  startedAt: Date.now() - 300_000,
                },
              },
              {
                id: "card-error",
                laneId: "failed",
                title: "Failed run",
                task: "",
                agentId: "main",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                run: {
                  runId: "run-err",
                  sessionKey: "main",
                  status: "error",
                  createdAt: Date.now(),
                  startedAt: Date.now() - 600_000,
                  endedAt: Date.now() - 300_000,
                  error: "boom",
                },
              },
            ],
          },
        ],
      }),
    );

    const now = Date.now();
    const context = buildContext({
      active: new Map([
        [
          "run-1",
          {
            controller: new AbortController(),
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: now - 300_000,
            expiresAtMs: now + 60_000,
          },
        ],
      ]),
      deltas: new Map([["run-1", now - 240_000]]),
    });

    let ok: boolean | null = null;
    let payload: unknown;

    await opsHandlers["ops.snapshot"]({
      req: { id: "req-ops", type: "req", method: "ops.snapshot" },
      params: { stalledAfterMs: 120_000 },
      client: null,
      context,
      isWebchatConnect: noop,
      respond: (nextOk, nextPayload) => {
        ok = nextOk;
        payload = nextPayload;
      },
    });

    expect(ok).toBe(true);
    const snapshot = payload as {
      orchestrator: {
        activeRuns: number;
        stalledRuns: number;
        errorRuns: number;
        active: Array<{ runId: string; cardId?: string }>;
      };
      hygiene: { installKind: string; checks: Array<{ id: string; status: string }> };
      voiceSystem: { status: string; degradedReasons: string[] };
    };

    expect(snapshot.orchestrator.activeRuns).toBe(1);
    expect(snapshot.orchestrator.stalledRuns).toBe(1);
    expect(snapshot.orchestrator.errorRuns).toBe(1);
    expect(snapshot.orchestrator.active[0]).toEqual(
      expect.objectContaining({ runId: "run-1", cardId: "card-running" }),
    );

    expect(snapshot.hygiene.installKind).toBe("git");
    expect(snapshot.hygiene.checks.some((check) => check.id === "branch-clean")).toBe(true);

    expect(snapshot.voiceSystem.status).toBe("degraded");
    expect(snapshot.voiceSystem.degradedReasons.join(" ")).toContain("Spark is disabled");
  });

  it("returns healthy defaults when no active runs or orchestrator state", async () => {
    const context = buildContext({});
    let ok: boolean | null = null;
    let payload: unknown;

    await opsHandlers["ops.snapshot"]({
      req: { id: "req-ops-empty", type: "req", method: "ops.snapshot" },
      params: {},
      client: null,
      context,
      isWebchatConnect: noop,
      respond: (nextOk, nextPayload) => {
        ok = nextOk;
        payload = nextPayload;
      },
    });

    expect(ok).toBe(true);
    const snapshot = payload as {
      orchestrator: { activeRuns: number; stalledRuns: number; errorRuns: number };
    };
    expect(snapshot.orchestrator.activeRuns).toBe(0);
    expect(snapshot.orchestrator.stalledRuns).toBe(0);
    expect(snapshot.orchestrator.errorRuns).toBe(0);
  });
});
