import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveNodeRunner } from "../../cli/update-cli/shared.js";
import { loadConfig } from "../../config/config.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
};

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },

  "doctor.run": async ({ params, respond }) => {
    const timeoutRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(Math.floor(timeoutRaw), 600_000)
        : 120_000;
    const deep = (params as { deep?: unknown }).deep === true;
    const started = Date.now();
    try {
      const root = await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
      if (!root) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "cannot resolve OpenClaw package root for doctor CLI"),
        );
        return;
      }
      const entryPath = path.join(root, "dist", "entry.js");
      const args = [entryPath, "doctor", "--non-interactive"];
      if (deep) {
        args.push("--deep");
      }
      try {
        const { stdout, stderr } = await execFileAsync(resolveNodeRunner(), args, {
          cwd: process.cwd(),
          env: process.env,
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
        });
        const durationMs = Date.now() - started;
        respond(
          true,
          {
            ok: true,
            exitCode: 0,
            signal: null,
            durationMs,
            timedOut: false,
            stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
            stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          },
          undefined,
        );
      } catch (err: unknown) {
        const e = err as {
          code?: string | number | null;
          signal?: string | null;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        const durationMs = Date.now() - started;
        const exitCode = typeof e.code === "number" ? e.code : 1;
        const timedOut = e.code === "ETIMEDOUT";
        respond(
          true,
          {
            ok: exitCode === 0,
            exitCode,
            signal: typeof e.signal === "string" ? e.signal : null,
            durationMs,
            timedOut,
            stdout:
              typeof e.stdout === "string"
                ? e.stdout
                : e.stdout && typeof Buffer !== "undefined" && Buffer.isBuffer(e.stdout)
                  ? e.stdout.toString("utf8")
                  : "",
            stderr:
              typeof e.stderr === "string"
                ? e.stderr
                : e.stderr && typeof Buffer !== "undefined" && Buffer.isBuffer(e.stderr)
                  ? e.stderr.toString("utf8")
                  : "",
          },
          undefined,
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatError(err)));
    }
  },
};
