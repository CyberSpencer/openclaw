import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveEffectiveEnv } from "./dgx-access.js";

const SPARK_SSH_SCRIPT = path.join("scripts", "spark_ssh.sh");
const DEFAULT_START_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_500;
const DEFAULT_HEALTH_URL = "http://127.0.0.1:8004/health";
const DEFAULT_REMOTE_HIT_FILE = "/home/dgx-aii/spark-worker/runtime/nemotron_last_hit_epoch";
const DEFAULT_REMOTE_SERVICE = "spark-nemotron.service";
/** User units live in ~/.config/systemd/user/; system units in /etc/systemd/system/. */
const DEFAULT_SYSTEMCTL_SCOPE = "user";

let inFlightEnsure: Promise<EnsureSparkVllmReadyResult> | null = null;

export type EnsureSparkVllmReadyResult = {
  ok: boolean;
  started: boolean;
  timedOut: boolean;
  detail: string;
};

function asInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeEnvValue(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function resolveWorkspaceRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, "..")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, SPARK_SSH_SCRIPT))) {
      return candidate;
    }
  }
  return cwd;
}

async function runLocalCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim() || "timed out" });
      },
      Math.max(1_000, params.timeoutMs),
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: stdout.trim(),
        stderr: `${stderr}\n${String(err)}`.trim(),
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function resolveHealthUrl(env: Record<string, string>): string {
  const explicit = normalizeEnvValue(
    env.SPARK_VLLM_HEALTH_URL || process.env.SPARK_VLLM_HEALTH_URL,
  );
  if (explicit) {
    return explicit;
  }
  const base = normalizeEnvValue(env.DGX_VLLM_URL || process.env.DGX_VLLM_URL).replace(/\/+$/, "");
  if (base) {
    return `${base}/health`;
  }
  const dgxHost = normalizeEnvValue(env.DGX_HOST || process.env.DGX_HOST);
  if (dgxHost) {
    return `http://${dgxHost}:8004/health`;
  }
  return DEFAULT_HEALTH_URL;
}

async function probeHealth(env: Record<string, string>): Promise<boolean> {
  const healthUrl = resolveHealthUrl(env);
  const timeoutMs = asInt(
    env.SPARK_VLLM_HEALTH_TIMEOUT_MS || process.env.SPARK_VLLM_HEALTH_TIMEOUT_MS,
    DEFAULT_HEALTH_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return false;
    }
    try {
      const body = (await resp.json()) as { status?: unknown; value?: unknown };
      const rawStatus = body?.status ?? body?.value;
      const status = (typeof rawStatus === "string" ? rawStatus : "").trim().toLowerCase();
      if (!status) {
        return true;
      }
      return status === "healthy" || status === "ok";
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runRemoteCommand(remoteCommand: string, timeoutMs: number, useSudo: boolean) {
  const workspaceRoot = resolveWorkspaceRoot();
  const scriptPath = path.join(workspaceRoot, SPARK_SSH_SCRIPT);
  const args = useSudo ? ["--sudo", "--", remoteCommand] : ["--", remoteCommand];
  return await runLocalCommand({
    command: scriptPath,
    args,
    cwd: workspaceRoot,
    timeoutMs,
  });
}

export function shouldWarmSparkVllmModel(modelRef: string | null | undefined): boolean {
  const value = (modelRef || "").trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (value.startsWith("vllm/") || value.startsWith("spark-vllm/")) {
    return true;
  }
  return value.includes("nemotron");
}

export async function noteSparkVllmUsage(): Promise<void> {
  const env = resolveEffectiveEnv();
  const remoteFile =
    (env.SPARK_VLLM_IDLE_LAST_HIT_FILE || process.env.SPARK_VLLM_IDLE_LAST_HIT_FILE || "").trim() ||
    DEFAULT_REMOTE_HIT_FILE;
  const touchCommand = `mkdir -p ${sh(path.posix.dirname(remoteFile))} && date +%s > ${sh(remoteFile)}`;
  const useSudo =
    (env.SPARK_VLLM_START_USE_SUDO || process.env.SPARK_VLLM_START_USE_SUDO || "").trim() !== "0";
  await runRemoteCommand(touchCommand, 10_000, useSudo);
}

export type EnsureSparkVllmReadyOptions = {
  /** Called when we need to start the service and poll (user will wait). Not called when already healthy. */
  onLoading?: () => void;
};

export async function ensureSparkVllmReady(
  opts?: EnsureSparkVllmReadyOptions,
): Promise<EnsureSparkVllmReadyResult> {
  if (inFlightEnsure) {
    return await inFlightEnsure;
  }
  inFlightEnsure = (async () => {
    const env = resolveEffectiveEnv();
    if (await probeHealth(env)) {
      void noteSparkVllmUsage();
      return { ok: true, started: false, timedOut: false, detail: "already healthy" };
    }

    opts?.onLoading?.();

    const scope =
      (env.SPARK_VLLM_SYSTEMCTL_SCOPE || process.env.SPARK_VLLM_SYSTEMCTL_SCOPE || "")
        .trim()
        .toLowerCase() || DEFAULT_SYSTEMCTL_SCOPE;
    const useSudo =
      scope === "user"
        ? false
        : (env.SPARK_VLLM_START_USE_SUDO || process.env.SPARK_VLLM_START_USE_SUDO || "").trim() !==
          "0";
    const serviceName =
      (env.SPARK_VLLM_SERVICE_NAME || process.env.SPARK_VLLM_SERVICE_NAME || "").trim() ||
      DEFAULT_REMOTE_SERVICE;
    const systemctlUser = scope === "user" ? " --user" : "";
    const startCommand = `systemctl${systemctlUser} start ${sh(serviceName)}`;
    const startRes = await runRemoteCommand(startCommand, 20_000, useSudo);
    if (!startRes.ok) {
      return {
        ok: false,
        started: false,
        timedOut: false,
        detail: startRes.stderr || startRes.stdout || "failed to start Spark vLLM service",
      };
    }

    const timeoutMs = asInt(
      env.SPARK_VLLM_START_TIMEOUT_MS || process.env.SPARK_VLLM_START_TIMEOUT_MS,
      DEFAULT_START_TIMEOUT_MS,
    );
    const pollIntervalMs = asInt(
      env.SPARK_VLLM_START_POLL_MS || process.env.SPARK_VLLM_START_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probeHealth(env)) {
        void noteSparkVllmUsage();
        return { ok: true, started: true, timedOut: false, detail: "Spark vLLM warmed" };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      ok: false,
      started: true,
      timedOut: true,
      detail: `Spark vLLM did not become healthy within ${timeoutMs}ms`,
    };
  })();
  try {
    return await inFlightEnsure;
  } finally {
    inFlightEnsure = null;
  }
}
