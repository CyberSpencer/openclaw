import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { deriveDefaultRootConversationId } from "../../orchestration/identity.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils.js";

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

type OrchestratorScope = {
  scopeKey: string;
  rootConversationId?: string;
};

type OrchestratorStoreResponse = {
  ok: true;
  exists: boolean;
  hash: string;
  scopeKey: string;
  rootConversationId?: string;
  state: OrchestratorState;
};

const MAIN_SCOPE_KEY = "main";

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

function resolveLegacyStorePath(): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "control-ui", "orchestrator.json");
}

function normalizeScopeKey(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return cleaned || MAIN_SCOPE_KEY;
}

function buildScopeKeyFromRootConversationId(rootConversationId: string): string {
  const digest = crypto.createHash("sha1").update(rootConversationId).digest("hex").slice(0, 16);
  return normalizeScopeKey(`root-${digest}`);
}

function resolveScopedStorePath(scopeKey: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "control-ui", "orchestrator", `${normalizeScopeKey(scopeKey)}.json`);
}

function readParamsRecord(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  return params as Record<string, unknown>;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function resolveRootConversationIdFromParams(record: Record<string, unknown>): string | undefined {
  const explicitRootConversationId = readTrimmedString(record, "rootConversationId");
  if (explicitRootConversationId) {
    return explicitRootConversationId;
  }

  const sessionKey = readTrimmedString(record, "sessionKey");
  if (!sessionKey) {
    return undefined;
  }

  try {
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
    const store = loadSessionStore(target.storePath);
    const lookupKey =
      target.storeKeys.find((candidate) => Boolean(store[candidate])) ?? target.canonicalKey;
    const entry = store[lookupKey] as SessionEntry | undefined;
    const entryRootConversationId =
      typeof entry?.rootConversationId === "string" ? entry.rootConversationId.trim() : "";
    return entryRootConversationId || deriveDefaultRootConversationId(target.canonicalKey);
  } catch {
    return deriveDefaultRootConversationId(sessionKey);
  }
}

function resolveOrchestratorScope(params: unknown): OrchestratorScope {
  const record = readParamsRecord(params);
  const rootConversationId = resolveRootConversationIdFromParams(record);
  if (rootConversationId) {
    return {
      scopeKey: buildScopeKeyFromRootConversationId(rootConversationId),
      rootConversationId,
    };
  }
  return { scopeKey: MAIN_SCOPE_KEY };
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

async function readStoreFromPath(
  storePath: string,
): Promise<
  | { ok: true; exists: true; raw: string; hash: string; state: OrchestratorState }
  | { ok: true; exists: false; raw: ""; hash: ""; state: OrchestratorState }
  | { ok: false; error: string }
> {
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

async function readStoreFile(
  scope: OrchestratorScope,
): Promise<
  | { ok: true; exists: true; raw: string; hash: string; state: OrchestratorState }
  | { ok: true; exists: false; raw: ""; hash: ""; state: OrchestratorState }
  | { ok: false; error: string }
> {
  const scopedPath = resolveScopedStorePath(scope.scopeKey);
  const scoped = await readStoreFromPath(scopedPath);
  if (!scoped.ok || scoped.exists || scope.scopeKey !== MAIN_SCOPE_KEY) {
    return scoped;
  }

  // Migration path: keep legacy board data for main scope when scoped file has
  // not been created yet.
  const legacyPath = resolveLegacyStorePath();
  return readStoreFromPath(legacyPath);
}

async function writeStoreFile(
  state: OrchestratorState,
  scope: OrchestratorScope,
): Promise<{ hash: string; raw: string }> {
  const storePath = resolveScopedStorePath(scope.scopeKey);
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
  "orchestrator.get": async ({ params, respond }) => {
    const scope = resolveOrchestratorScope(params);
    const res = await readStoreFile(scope);
    if (!res.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, res.error));
      return;
    }
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: res.exists,
      hash: res.hash,
      scopeKey: scope.scopeKey,
      ...(scope.rootConversationId ? { rootConversationId: scope.rootConversationId } : {}),
      state: res.state,
    };
    respond(true, payload, undefined);
  },

  "orchestrator.set": async ({ params, respond, context }) => {
    const record = readParamsRecord(params);
    const scope = resolveOrchestratorScope(record);
    const stateValue = record.state;
    const baseHash = readTrimmedString(record, "baseHash");
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

    const current = await readStoreFile(scope);
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

    const written = await writeStoreFile(state, scope);
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: true,
      hash: written.hash,
      scopeKey: scope.scopeKey,
      ...(scope.rootConversationId ? { rootConversationId: scope.rootConversationId } : {}),
      state,
    };
    context.broadcast(
      "orchestrator",
      {
        state,
        hash: written.hash,
        scopeKey: scope.scopeKey,
        ...(scope.rootConversationId ? { rootConversationId: scope.rootConversationId } : {}),
      },
      { dropIfSlow: true },
    );
    respond(true, payload, undefined);
  },

  "orchestrator.reset": async ({ params, respond, context }) => {
    const scope = resolveOrchestratorScope(params);
    const state = createDefaultState();
    const written = await writeStoreFile(state, scope);
    const payload: OrchestratorStoreResponse = {
      ok: true,
      exists: true,
      hash: written.hash,
      scopeKey: scope.scopeKey,
      ...(scope.rootConversationId ? { rootConversationId: scope.rootConversationId } : {}),
      state,
    };
    context.broadcast(
      "orchestrator",
      {
        state,
        hash: written.hash,
        scopeKey: scope.scopeKey,
        ...(scope.rootConversationId ? { rootConversationId: scope.rootConversationId } : {}),
      },
      { dropIfSlow: true },
    );
    respond(true, payload, undefined);
  },
};
