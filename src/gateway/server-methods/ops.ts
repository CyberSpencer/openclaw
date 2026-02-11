import { spawn } from "node:child_process";
import type { GatewayRequestHandlers } from "./types.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
};
