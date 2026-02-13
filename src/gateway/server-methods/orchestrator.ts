import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

type OrchestrationLaneId = "backlog" | "running" | "review" | "done" | "failed" | (string & {});

type OrchestrationLane = {
  id: OrchestrationLaneId;
  title: string;
  description?: string;
};

type OrchestrationCard = {
  id: string;
  laneId: OrchestrationLaneId;
  runner?: "subagent" | "codex";
  title: string;
  task: string;
  agentId: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  cleanup?: "keep" | "delete";
  tags?: string[];
  codexMode?: "plan" | "apply" | "run";
  codexShellAllowlist?: string[];
  run?: unknown;
  createdAt: number;
  updatedAt: number;
};

type OrchestrationBoard = {
  id: string;
  title: string;
  lanes: OrchestrationLane[];
  cards: OrchestrationCard[];
  createdAt: number;
  updatedAt: number;
};

type OrchestratorState = {
  version: 1;
  selectedBoardId: string;
  boards: OrchestrationBoard[];
};

type OrchestratorStoreResponse = {
  ok: true;
  exists: boolean;
  hash: string;
  state: OrchestratorState;
};

const DEFAULT_LANES: OrchestrationLane[] = [
  { id: "backlog", title: "Backlog", description: "Queued work and ideas." },
  { id: "running", title: "Running", description: "Active sub-agent runs." },
  { id: "review", title: "Review", description: "Inspect results, promote, or retry." },
  { id: "done", title: "Done", description: "Accepted outcomes." },
  { id: "failed", title: "Failed", description: "Needs edits or reruns." },
];

function createDefaultState(now = Date.now()): OrchestratorState {
  return {
    version: 1,
    selectedBoardId: "main",
    boards: [
      {
        id: "main",
        title: "Mission Control",
        lanes: DEFAULT_LANES.map((lane) => ({ ...lane })),
        cards: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function computeHash(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function resolveStorePath(): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "control-ui", "orchestrator.json");
}

async function quarantineInvalidStore(storePath: string, raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  try {
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = `${storePath}.corrupt.${stamp}`;
    await fs.promises.writeFile(out, raw, "utf8");
  } catch {
    // best-effort
  }
}

async function readStoreFile(): Promise<
  | { ok: true; exists: true; raw: string; hash: string; state: OrchestratorState }
  | { ok: true; exists: false; raw: ""; hash: ""; state: OrchestratorState }
  | { ok: false; error: string }
> {
  const storePath = resolveStorePath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(storePath, "utf8");
  } catch (err) {
    const errCode =
      err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : "";
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : errCode
            ? `Error ${errCode}`
            : "";
    if (
      errCode === "ENOENT" ||
      message.includes("ENOENT") ||
      // node sometimes stringifies as: "Error: ENOENT: no such file or directory"
      message.includes("no such file or directory")
    ) {
      return { ok: true, exists: false, raw: "", hash: "", state: createDefaultState() };
    }
    return { ok: false, error: message || "failed to read orchestrator store" };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, exists: false, raw: "", hash: "", state: createDefaultState() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    await quarantineInvalidStore(storePath, raw);
    return { ok: true, exists: false, raw: "", hash: "", state: createDefaultState() };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await quarantineInvalidStore(storePath, raw);
    return { ok: true, exists: false, raw: "", hash: "", state: createDefaultState() };
  }
  const state = parsed as OrchestratorState;
  if (state.version !== 1 || !Array.isArray(state.boards)) {
    await quarantineInvalidStore(storePath, raw);
    return { ok: true, exists: false, raw: "", hash: "", state: createDefaultState() };
  }
  return {
    ok: true,
    exists: true,
    raw: trimmed,
    hash: computeHash(trimmed),
    state,
  };
}

async function writeStoreFile(state: OrchestratorState): Promise<{ hash: string; raw: string }> {
  const storePath = resolveStorePath();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, raw, "utf8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
  return { hash: computeHash(raw.trim()), raw };
}

export const orchestratorHandlers: GatewayRequestHandlers = {
  "orchestrator.get": async ({ respond }) => {
    const res = await readStoreFile();
    if (!res.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, res.error));
      return;
    }
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: res.exists,
      hash: res.hash,
      state: res.state,
    };
    respond(true, payload, undefined);
  },

  "orchestrator.set": async ({ params, respond, context }) => {
    const stateValue = (params as { state?: unknown }).state;
    const baseHashValue = (params as { baseHash?: unknown }).baseHash;
    const baseHash = typeof baseHashValue === "string" ? baseHashValue.trim() : "";
    if (!stateValue || typeof stateValue !== "object" || Array.isArray(stateValue)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid orchestrator.set params: state required"),
      );
      return;
    }
    const state = stateValue as OrchestratorState;
    if (state.version !== 1 || !Array.isArray(state.boards)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid orchestrator state: unsupported version"),
      );
      return;
    }

    const current = await readStoreFile();
    if (!current.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, current.error));
      return;
    }
    if (current.exists && baseHash && baseHash !== current.hash) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "orchestrator.set conflict: baseHash mismatch; reload and retry",
        ),
      );
      return;
    }

    const written = await writeStoreFile(state);
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: true,
      hash: written.hash,
      state,
    };
    context.broadcast("orchestrator", { state, hash: written.hash }, { dropIfSlow: true });
    respond(true, payload, undefined);
  },

  "orchestrator.reset": async ({ respond, context }) => {
    const state = createDefaultState();
    const written = await writeStoreFile(state);
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: true,
      hash: written.hash,
      state,
    };
    context.broadcast("orchestrator", { state, hash: written.hash }, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
