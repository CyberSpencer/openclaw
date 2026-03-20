import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("router-runtime");

export type RouterDecision = {
  target?: string;
  mode?: string;
  model?: string;
  thinking?: string;
  reason?: string;
  task_class?: string;
  delegate?: boolean;
  delegate_model?: string;
  review_required?: boolean;
  review_model?: string;
};

export type ParsedRouterModel = {
  provider: string;
  modelId: string;
};

export function parseRouterModel(raw?: string): ParsedRouterModel | null {
  if (!raw) {
    return null;
  }
  const idx = raw.indexOf("/");
  if (idx <= 0 || idx === raw.length - 1) {
    return null;
  }
  return {
    provider: raw.slice(0, idx),
    modelId: raw.slice(idx + 1),
  };
}

export async function runModelRouter(params: {
  workspaceDir: string;
  prompt: string;
  mode: "text" | "voice";
  routerFailureReason?: string;
  routerFailureModel?: string;
  timeoutMs?: number;
}): Promise<RouterDecision | null> {
  const scriptPath = path.join(params.workspaceDir, "scripts", "route.sh");
  let resolvedScriptPath: string;
  try {
    await fs.access(scriptPath);
    const [realWorkspaceDir, realScriptPath] = await Promise.all([
      fs.realpath(params.workspaceDir),
      fs.realpath(scriptPath),
    ]);
    const rel = path.relative(realWorkspaceDir, realScriptPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      log.warn("router script is not contained within workspaceDir; refusing to execute");
      return null;
    }
    resolvedScriptPath = realScriptPath;
  } catch {
    return null;
  }

  const timeoutMs = params.timeoutMs ?? 2_500;
  return await new Promise((resolve) => {
    const child = spawn(resolvedScriptPath, ["--json", "--mode", params.mode], {
      cwd: params.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ROUTER_OPENAI_FAILURE_REASON: params.routerFailureReason ?? "",
        ROUTER_OPENAI_FAILURE_MODEL: params.routerFailureModel ?? "",
        OPENCLAW_OPENAI_FAILURE_REASON: params.routerFailureReason ?? "",
        OPENCLAW_OPENAI_FAILURE_MODEL: params.routerFailureModel ?? "",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log.warn(`router spawn error: ${String(err).slice(0, 200)}`);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        if (stderr.trim()) {
          log.warn(`router failed (${code ?? "signal"}): ${stderr.trim().slice(0, 200)}`);
        }
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as RouterDecision);
      } catch (err) {
        log.warn(`router JSON parse failed: ${String(err).slice(0, 200)}`);
        resolve(null);
      }
    });
    child.stdin.end(params.prompt);
  });
}
