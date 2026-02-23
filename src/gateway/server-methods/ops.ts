import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { checkUpdateStatus, type UpdateCheckResult } from "../../infra/update-check.js";
import { routerStatusHandlers } from "./router-status.js";
import { sparkStatusHandlers } from "./spark-status.js";

type OpsStatus = "healthy" | "degraded" | "down" | "unknown";

type OpsSnapshot = {
  generatedAt: number;
  orchestrator: {
    status: OpsStatus;
    activeRuns: number;
    stalledRuns: number;
    errorRuns: number;
    stalledAfterMs: number;
    active: Array<{
      runId: string;
      sessionKey: string;
      startedAt: number;
      ageMs: number;
      lastDeltaAt: number | null;
      idleMs: number;
      stalled: boolean;
      boardId?: string;
      boardTitle?: string;
      cardId?: string;
      cardTitle?: string;
      laneId?: string;
    }>;
    links: Array<{
      label: string;
      tab: "orchestrator";
      boardId?: string;
      cardId?: string;
    }>;
  };
  hygiene: {
    status: OpsStatus;
    installKind: "git" | "package" | "unknown";
    packageManager: string;
    git: {
      branch: string | null;
      upstream: string | null;
      dirty: boolean | null;
      ahead: number | null;
      behind: number | null;
      fetchOk: boolean | null;
      sha: string | null;
    } | null;
    deps: {
      status: "ok" | "missing" | "stale" | "unknown";
      reason?: string;
    } | null;
    ci: {
      detected: boolean;
      provider: string | null;
      workflow: string | null;
      event: string | null;
      branch: string | null;
      runId: string | null;
      runUrl: string | null;
    };
    pr: {
      detected: boolean;
      number: number | null;
      url: string | null;
      baseRef: string | null;
      headRef: string | null;
    };
    checks: Array<{
      id: string;
      label: string;
      status: OpsStatus;
      detail: string;
    }>;
  };
  voiceSystem: {
    status: OpsStatus;
    degradedReasons: string[];
    router: {
      enabled: boolean;
      healthy: boolean;
      url?: string;
      checkedAt?: number;
      status?: number;
      error?: string;
    } | null;
    spark: {
      enabled: boolean;
      active: boolean;
      source?: "dgx-stats" | "fallback";
      host?: string | null;
      checkedAt?: number;
      voiceAvailable?: boolean;
      overall?: "healthy" | "degraded" | "down" | "unknown";
      error?: string;
      services?: Record<
        string,
        {
          healthy?: boolean;
          status?: number;
          error?: string | null;
          url?: string;
          latency_ms?: number;
        }
      >;
    } | null;
    links: Array<{ label: string; tab: "overview" | "dgx" }>;
  };
};

type OrchestratorRunRef = {
  boardId: string;
  boardTitle?: string;
  cardId: string;
  cardTitle?: string;
  laneId?: string;
};

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function combineStatus(statuses: OpsStatus[]): OpsStatus {
  if (statuses.includes("down")) {
    return "down";
  }
  if (statuses.includes("degraded")) {
    return "degraded";
  }
  if (statuses.includes("healthy")) {
    return "healthy";
  }
  return "unknown";
}

async function runCommand(params: {
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes?: number;
}): Promise<{
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const startedAt = Date.now();
  const maxOutput = params.maxOutputBytes ?? 350_000;
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;

  return await new Promise((resolve) => {
    let resolved = false;
    let timedOut = false;
    const child = spawn(params.command, params.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const clampAppend = (target: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, maxOutput - (stdoutBytes + stderrBytes));
      if (remaining <= 0) {
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (target === "stdout") {
        stdout += slice.toString("utf8");
        stdoutBytes += slice.length;
      } else {
        stderr += slice.toString("utf8");
        stderrBytes += slice.length;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => clampAppend("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => clampAppend("stderr", chunk));

    const timer = setTimeout(
      () => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      },
      Math.max(0, Math.floor(params.timeoutMs)),
    );

    child.on("error", (err) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      const durationMs = Math.max(0, Date.now() - startedAt);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
        stdout: stdout.trimEnd(),
        stderr: [stderr.trimEnd(), String(err ?? "")].filter(Boolean).join("\n"),
      });
    });

    child.on("close", (code, signal) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      const durationMs = Math.max(0, Date.now() - startedAt);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        durationMs,
        timedOut,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}

async function callInternalHandler<T>(params: {
  handler: GatewayRequestHandler;
  method: string;
  context: GatewayRequestHandlerOptions["context"];
}): Promise<{ ok: boolean; payload: T | null; error: string | null }> {
  let called = false;
  let ok = false;
  let payload: T | null = null;
  let error: string | null = null;

  try {
    await params.handler({
      req: {
        id: `ops-snapshot:${params.method}`,
        type: "req",
        method: params.method,
        params: {},
      },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: (nextOk, nextPayload, nextError) => {
        called = true;
        ok = nextOk;
        payload = (nextPayload as T | undefined) ?? null;
        error = nextError?.message ?? null;
      },
      context: params.context,
    });
  } catch (err) {
    return {
      ok: false,
      payload: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!called) {
    return { ok: false, payload: null, error: "handler did not respond" };
  }
  return { ok, payload, error };
}

function extractBoards(raw: unknown): unknown[] {
  const root = asRecord(raw);
  if (!root) {
    return [];
  }
  if (Array.isArray(root.boards)) {
    return root.boards;
  }
  const nestedState = asRecord(root.state);
  if (nestedState && Array.isArray(nestedState.boards)) {
    return nestedState.boards;
  }
  return [];
}

async function collectOrchestratorRunRefs(): Promise<{
  refs: Map<string, OrchestratorRunRef>;
  errorRuns: number;
}> {
  const refs = new Map<string, OrchestratorRunRef>();
  const errorRunIds = new Set<string>();
  const stateDir = resolveStateDir(process.env, os.homedir);
  const controlUiDir = path.join(stateDir, "control-ui");
  const scopedDir = path.join(controlUiDir, "orchestrator");
  const files: string[] = [];

  try {
    const entries = await fs.readdir(scopedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      files.push(path.join(scopedDir, entry.name));
    }
  } catch {
    // ignore missing dir
  }

  const legacyFile = path.join(controlUiDir, "orchestrator.json");
  try {
    await fs.access(legacyFile);
    files.push(legacyFile);
  } catch {
    // ignore missing file
  }

  for (const filePath of files) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
      for (const boardRaw of extractBoards(raw)) {
        const board = asRecord(boardRaw);
        if (!board) {
          continue;
        }
        const boardId = readString(board.id)?.trim() || "main";
        const boardTitle = readString(board.title)?.trim() || undefined;
        if (!Array.isArray(board.cards)) {
          continue;
        }
        for (const cardRaw of board.cards) {
          const card = asRecord(cardRaw);
          if (!card) {
            continue;
          }
          const cardId = readString(card.id)?.trim();
          if (!cardId) {
            continue;
          }
          const run = asRecord(card.run);
          if (!run) {
            continue;
          }
          const runId = readString(run.runId)?.trim();
          if (!runId) {
            continue;
          }
          refs.set(runId, {
            boardId,
            boardTitle,
            cardId,
            cardTitle: readString(card.title)?.trim() || undefined,
            laneId: readString(card.laneId)?.trim() || undefined,
          });
          if (readString(run.status) === "error") {
            errorRunIds.add(runId);
          }
        }
      }
    } catch {
      // ignore malformed state files
    }
  }

  return {
    refs,
    errorRuns: errorRunIds.size,
  };
}

function resolveCiSignals() {
  const env = process.env;
  const provider = env.GITHUB_ACTIONS === "true" ? "github-actions" : env.CI ? "ci" : null;
  const detected = Boolean(provider);
  const branch =
    env.GITHUB_HEAD_REF?.trim() || env.GITHUB_REF_NAME?.trim() || env.BRANCH_NAME?.trim() || null;
  const runId = env.GITHUB_RUN_ID?.trim() || null;
  const repo = env.GITHUB_REPOSITORY?.trim() || null;
  const server = env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  const runUrl = runId && repo ? `${server}/${repo}/actions/runs/${runId}` : null;
  return {
    detected,
    provider,
    workflow: env.GITHUB_WORKFLOW?.trim() || null,
    event: env.GITHUB_EVENT_NAME?.trim() || null,
    branch,
    runId,
    runUrl,
  };
}

function resolvePrSignals(ci: ReturnType<typeof resolveCiSignals>) {
  const env = process.env;
  const event = env.GITHUB_EVENT_NAME?.trim();
  const fromRef = (() => {
    const match = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
    if (!match) {
      return null;
    }
    const num = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(num) ? num : null;
  })();
  const fromEnv = (() => {
    const raw = env.PR_NUMBER?.trim();
    if (!raw) {
      return null;
    }
    const num = Number.parseInt(raw, 10);
    return Number.isFinite(num) ? num : null;
  })();

  const number = fromRef ?? fromEnv;
  const repo = env.GITHUB_REPOSITORY?.trim() || null;
  const server = env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  const detected = Boolean(number != null || event?.includes("pull_request"));

  return {
    detected,
    number,
    url: number != null && repo ? `${server}/${repo}/pull/${number}` : null,
    baseRef: env.GITHUB_BASE_REF?.trim() || null,
    headRef: env.GITHUB_HEAD_REF?.trim() || ci.branch,
  };
}

async function buildOpsSnapshot(params: {
  context: GatewayRequestHandlerOptions["context"];
  stalledAfterMs: number;
}): Promise<OpsSnapshot> {
  const now = Date.now();

  const [{ refs, errorRuns }, updateResult, routerResult, sparkResult] = await Promise.all([
    collectOrchestratorRunRefs(),
    checkUpdateStatus({
      root: process.cwd(),
      timeoutMs: 4_000,
      fetchGit: false,
      includeRegistry: false,
    }).catch(
      (): UpdateCheckResult => ({
        root: null,
        installKind: "unknown",
        packageManager: "unknown",
      }),
    ),
    callInternalHandler<{
      enabled?: boolean;
      healthy?: boolean;
      url?: string;
      checkedAt?: number;
      status?: number;
      error?: string;
    }>({
      handler: routerStatusHandlers["router.status"],
      method: "router.status",
      context: params.context,
    }),
    callInternalHandler<{
      enabled?: boolean;
      active?: boolean;
      source?: "dgx-stats" | "fallback";
      host?: string | null;
      checkedAt?: number;
      voiceAvailable?: boolean;
      overall?: "healthy" | "degraded" | "down" | "unknown";
      error?: string;
      services?: Record<
        string,
        {
          healthy?: boolean;
          status?: number;
          error?: string | null;
          url?: string;
          latency_ms?: number;
        }
      >;
    }>({
      handler: sparkStatusHandlers["spark.status"],
      method: "spark.status",
      context: params.context,
    }),
  ]);

  const activeRuns: OpsSnapshot["orchestrator"]["active"] = [];
  for (const [runId, entry] of params.context.chatAbortControllers.entries()) {
    const startedAt = readNumber(entry.startedAtMs) ?? now;
    const lastDeltaAtRaw = params.context.chatDeltaSentAt.get(runId);
    const lastDeltaAt =
      typeof lastDeltaAtRaw === "number" && Number.isFinite(lastDeltaAtRaw) ? lastDeltaAtRaw : null;
    const ageMs = Math.max(0, now - startedAt);
    const idleBase = lastDeltaAt != null ? Math.max(startedAt, lastDeltaAt) : startedAt;
    const idleMs = Math.max(0, now - idleBase);
    const stalled = idleMs >= params.stalledAfterMs && ageMs >= params.stalledAfterMs;
    const ref = refs.get(runId);
    activeRuns.push({
      runId,
      sessionKey: entry.sessionKey,
      startedAt,
      ageMs,
      lastDeltaAt,
      idleMs,
      stalled,
      boardId: ref?.boardId,
      boardTitle: ref?.boardTitle,
      cardId: ref?.cardId,
      cardTitle: ref?.cardTitle,
      laneId: ref?.laneId,
    });
  }

  activeRuns.sort((a, b) => a.startedAt - b.startedAt);

  const stalledRuns = activeRuns.filter((run) => run.stalled).length;
  const orchestratorStatus: OpsStatus =
    stalledRuns > 0 ? "down" : errorRuns > 0 ? "degraded" : "healthy";
  const orchestratorLinks = dedupeStrings(
    activeRuns.filter((run) => run.cardId).map((run) => run.cardTitle?.trim() || run.runId),
  ).slice(0, 6);

  const ci = resolveCiSignals();
  const pr = resolvePrSignals(ci);
  const updateGit = updateResult.git;
  const updateDeps = updateResult.deps;
  const hygieneChecks: OpsSnapshot["hygiene"]["checks"] = [];

  if (updateResult.installKind === "git" && updateGit) {
    hygieneChecks.push({
      id: "branch-clean",
      label: "Branch clean",
      status: updateGit.dirty == null ? "unknown" : updateGit.dirty ? "degraded" : "healthy",
      detail:
        updateGit.dirty == null
          ? "Unable to determine git working tree state"
          : updateGit.dirty
            ? "Working tree has uncommitted changes"
            : "Working tree is clean",
    });

    const behind = readNumber(updateGit.behind);
    const ahead = readNumber(updateGit.ahead);
    const diverged = (ahead ?? 0) > 0 && (behind ?? 0) > 0;
    hygieneChecks.push({
      id: "branch-sync",
      label: "Branch sync",
      status:
        updateGit.upstream == null
          ? "unknown"
          : diverged
            ? "degraded"
            : (behind ?? 0) > 0
              ? "degraded"
              : "healthy",
      detail:
        updateGit.upstream == null
          ? "No upstream tracking branch"
          : diverged
            ? `Diverged from ${updateGit.upstream} (ahead ${ahead ?? 0}, behind ${behind ?? 0})`
            : (behind ?? 0) > 0
              ? `Behind ${updateGit.upstream} by ${behind ?? 0}`
              : (ahead ?? 0) > 0
                ? `Ahead of ${updateGit.upstream} by ${ahead ?? 0}`
                : `In sync with ${updateGit.upstream}`,
    });
  } else {
    hygieneChecks.push({
      id: "install-kind",
      label: "Install kind",
      status: updateResult.installKind === "unknown" ? "unknown" : "healthy",
      detail:
        updateResult.installKind === "package"
          ? "Package install (no git branch hygiene checks)"
          : "Unable to determine install type",
    });
  }

  if (updateDeps) {
    hygieneChecks.push({
      id: "deps",
      label: "Dependencies",
      status:
        updateDeps.status === "ok"
          ? "healthy"
          : updateDeps.status === "unknown"
            ? "unknown"
            : "degraded",
      detail:
        updateDeps.status === "ok"
          ? "Dependency markers match lockfile"
          : (updateDeps.reason ?? `Dependency status: ${updateDeps.status}`),
    });
  }

  hygieneChecks.push({
    id: "ci",
    label: "CI",
    status: ci.detected ? "healthy" : "unknown",
    detail: ci.detected
      ? `${ci.provider ?? "ci"}${ci.workflow ? ` · ${ci.workflow}` : ""}`
      : "No CI context detected",
  });

  hygieneChecks.push({
    id: "pr",
    label: "Pull request",
    status: pr.detected ? "healthy" : "unknown",
    detail:
      pr.number != null
        ? `PR #${pr.number}${pr.baseRef ? ` (${pr.headRef ?? "head"} → ${pr.baseRef})` : ""}`
        : "No pull request context detected",
  });

  const hygieneStatus = combineStatus(hygieneChecks.map((check) => check.status));

  const routerPayload = routerResult.ok ? routerResult.payload : null;
  const sparkPayload = sparkResult.ok ? sparkResult.payload : null;

  const router: OpsSnapshot["voiceSystem"]["router"] = routerPayload
    ? {
        enabled: readBoolean(routerPayload.enabled) ?? false,
        healthy: readBoolean(routerPayload.healthy) ?? false,
        url: readString(routerPayload.url),
        checkedAt: readNumber(routerPayload.checkedAt),
        status: readNumber(routerPayload.status),
        error: readString(routerPayload.error),
      }
    : null;
  const spark: OpsSnapshot["voiceSystem"]["spark"] = sparkPayload
    ? {
        enabled: readBoolean(sparkPayload.enabled) ?? false,
        active: readBoolean(sparkPayload.active) ?? false,
        source:
          sparkPayload.source === "dgx-stats" || sparkPayload.source === "fallback"
            ? sparkPayload.source
            : undefined,
        host: (readString(sparkPayload.host) ?? null) as string | null,
        checkedAt: readNumber(sparkPayload.checkedAt),
        voiceAvailable: readBoolean(sparkPayload.voiceAvailable),
        overall:
          sparkPayload.overall === "healthy" ||
          sparkPayload.overall === "degraded" ||
          sparkPayload.overall === "down" ||
          sparkPayload.overall === "unknown"
            ? sparkPayload.overall
            : undefined,
        error: readString(sparkPayload.error),
        services:
          sparkPayload.services && typeof sparkPayload.services === "object"
            ? sparkPayload.services
            : undefined,
      }
    : null;

  const degradedReasons: string[] = [];

  if (!router) {
    degradedReasons.push(
      `Router status unavailable${routerResult.error ? `: ${routerResult.error}` : ""}.`,
    );
  } else if (!router.enabled) {
    degradedReasons.push("NVIDIA router is disabled.");
  } else if (!router.healthy) {
    degradedReasons.push(
      router.error ? `NVIDIA router unhealthy: ${router.error}.` : "NVIDIA router is unhealthy.",
    );
  }

  if (!spark) {
    degradedReasons.push(
      `Spark status unavailable${sparkResult.error ? `: ${sparkResult.error}` : ""}.`,
    );
  } else {
    if (!spark.enabled) {
      degradedReasons.push("Spark is disabled.");
    }
    if (spark.overall === "down") {
      degradedReasons.push("Spark overall status is down.");
    } else if (spark.overall === "degraded") {
      degradedReasons.push("Spark overall status is degraded.");
    }
    if (spark.voiceAvailable === false) {
      degradedReasons.push("Spark voice pipeline is unavailable.");
    }
    if (spark.services) {
      for (const [name, svcRaw] of Object.entries(spark.services)) {
        const svc = asRecord(svcRaw);
        if (!svc) {
          continue;
        }
        const healthy = readBoolean(svc.healthy);
        if (healthy !== false) {
          continue;
        }
        const detail =
          readString(svc.error) ??
          (readNumber(svc.status) ? `HTTP ${readNumber(svc.status)}` : "unknown error");
        degradedReasons.push(`Spark service ${name} unhealthy${detail ? `: ${detail}` : ""}.`);
      }
    }
  }

  const uniqueReasons = dedupeStrings(degradedReasons).slice(0, 12);
  const voiceStatus = (() => {
    if (!router && !spark) {
      return "unknown" satisfies OpsStatus;
    }
    if (spark?.overall === "down") {
      return "down" satisfies OpsStatus;
    }
    if (uniqueReasons.length > 0) {
      return "degraded" satisfies OpsStatus;
    }
    return "healthy" satisfies OpsStatus;
  })();

  return {
    generatedAt: now,
    orchestrator: {
      status: orchestratorStatus,
      activeRuns: activeRuns.length,
      stalledRuns,
      errorRuns,
      stalledAfterMs: params.stalledAfterMs,
      active: activeRuns,
      links: [
        { label: "Open Orchestrator", tab: "orchestrator" as const },
        ...orchestratorLinks.map((label) => ({ label, tab: "orchestrator" as const })),
      ].slice(0, 8),
    },
    hygiene: {
      status: hygieneStatus,
      installKind: updateResult.installKind,
      packageManager: updateResult.packageManager,
      git: updateGit
        ? {
            branch: updateGit.branch,
            upstream: updateGit.upstream,
            dirty: updateGit.dirty,
            ahead: updateGit.ahead,
            behind: updateGit.behind,
            fetchOk: updateGit.fetchOk,
            sha: updateGit.sha,
          }
        : null,
      deps: updateDeps
        ? {
            status: updateDeps.status,
            reason: updateDeps.reason,
          }
        : null,
      ci,
      pr,
      checks: hygieneChecks,
    },
    voiceSystem: {
      status: voiceStatus,
      degradedReasons: uniqueReasons,
      router,
      spark,
      links: [
        { label: "Overview", tab: "overview" },
        { label: "DGX", tab: "dgx" },
      ],
    },
  };
}

export const opsHandlers: GatewayRequestHandlers = {
  "gateway.restart": async ({ params, respond }) => {
    const delayMsRaw = readNumber((params as { delayMs?: unknown }).delayMs);
    const delayMs = delayMsRaw != null ? Math.max(0, Math.floor(delayMsRaw)) : undefined;
    const reason = readString((params as { reason?: unknown }).reason)?.trim();
    const restart = scheduleGatewaySigusr1Restart({
      delayMs,
      reason: reason || "gateway.restart",
    });
    respond(true, { ok: true, restart }, undefined);
  },

  "doctor.run": async ({ params, respond }) => {
    const timeoutMsRaw = readNumber((params as { timeoutMs?: unknown }).timeoutMs);
    const timeoutMs = timeoutMsRaw != null ? Math.max(1_000, Math.floor(timeoutMsRaw)) : 120_000;
    const deep = Boolean((params as { deep?: unknown }).deep);
    const args = ["doctor", "--non-interactive"];
    if (deep) {
      args.push("--deep");
    }

    const result = await runCommand({
      command: "openclaw",
      args,
      timeoutMs,
    });

    respond(true, result, undefined);
  },

  "ops.snapshot": async ({ params, context, respond }) => {
    const stalledAfterMsRaw = readNumber((params as { stalledAfterMs?: unknown }).stalledAfterMs);
    const stalledAfterMs =
      stalledAfterMsRaw != null
        ? Math.min(30 * 60_000, Math.max(30_000, Math.floor(stalledAfterMsRaw)))
        : 2 * 60_000;

    try {
      const snapshot = await buildOpsSnapshot({ context, stalledAfterMs });
      respond(true, snapshot, undefined);
    } catch (err) {
      respond(false, undefined, {
        code: "unavailable",
        message: String(err),
      });
    }
  },
};
