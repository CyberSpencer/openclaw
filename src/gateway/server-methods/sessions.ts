import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listFinishedSessions as listFinishedProcessSessions,
  listRunningSessions as listRunningProcessSessions,
} from "../../agents/bash-process-registry.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { unbindThreadBindingsBySessionKey } from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsSubagentsParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSpawnParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import type { SessionsSubagentsResult, SubagentTaskRow } from "../session-utils.types.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function detectBackgroundCodingAgent(command: string): { label: string } | null {
  const normalized = command.trim();
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (/\bcodex\b/.test(lower)) {
    return { label: "Codex background agent" };
  }
  const firstToken = normalized.match(/^\S+/)?.[0]?.toLowerCase() ?? "";
  const isCursorAgentExecutable = /^(?:\.\/|.*\/)?agent$/.test(firstToken);
  if (/run_cursor\.py|\bcursor-agent\b/.test(lower) || isCursorAgentExecutable) {
    return { label: "Cursor background agent" };
  }
  if (/\bclaude\b/.test(lower) && /--print|--permission-mode/.test(lower)) {
    return { label: "Claude Code background agent" };
  }
  if (/\bopencode\b/.test(lower)) {
    return { label: "OpenCode background agent" };
  }
  if (/(^|[\s"'`/])(?:pi|pi-cli|pi\.exe)(?=$|[\s"'`/])/.test(lower)) {
    return { label: "Pi background agent" };
  }
  return null;
}

function normalizeBackgroundAgentTask(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact || "background coding agent";
}

function listBackgroundCodingRowsForRequester(
  requesterSessionKey: string,
  includeCompleted: boolean,
): SubagentTaskRow[] {
  const target = requesterSessionKey.trim();
  if (!target) {
    return [];
  }

  const runningRows = listRunningProcessSessions()
    .filter((entry) => (entry.sessionKey ?? "").trim() === target)
    .map((entry) => ({ entry, status: "running" as const, endedAt: undefined }));
  const finishedRows = includeCompleted
    ? listFinishedProcessSessions()
        .filter(
          (entry) =>
            (entry.scopeKey ?? "").trim() === target ||
            (entry as { sessionKey?: string }).sessionKey?.trim() === target,
        )
        .map((entry) => ({
          entry,
          status: entry.status === "completed" ? ("done" as const) : ("error" as const),
          endedAt: entry.endedAt,
        }))
    : [];

  return [...runningRows, ...finishedRows]
    .map(({ entry, status, endedAt }) => {
      const agent = detectBackgroundCodingAgent(entry.command);
      if (!agent) {
        return null;
      }
      const task = normalizeBackgroundAgentTask(entry.command);
      const runtimeMs = Math.max(0, (endedAt ?? Date.now()) - entry.startedAt);
      return {
        taskId: entry.id,
        title: agent.label,
        runId: entry.id,
        assignedRunId: entry.id,
        childSessionKey: `process:${entry.id}`,
        assignedSessionKey: `process:${entry.id}`,
        requesterSessionKey: target,
        source: "background-exec",
        openable: false,
        label: agent.label,
        task,
        status,
        cleanup: "keep",
        outcome:
          status === "error"
            ? { status: "error", error: task }
            : status === "done"
              ? { status: "ok" }
              : undefined,
        createdAt: entry.startedAt,
        startedAt: entry.startedAt,
        endedAt,
        runtimeMs,
      } satisfies SubagentTaskRow;
    })
    .filter((row): row is SubagentTaskRow => Boolean(row));
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscripts({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  unbindThreadBindingsBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind,
    reason: params.reason,
    sendFarewell: true,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  clearBootstrapSnapshot(params.target.canonicalKey);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  if (ended) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.subagents": ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSessionsSubagentsParams, "sessions.subagents", respond)
    ) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const rawRequester = String(p.requesterSessionKey ?? "").trim();
    if (!rawRequester) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "requesterSessionKey required"),
      );
      return;
    }

    const requesterSessionKey = rawRequester === "main" ? resolveMainSessionKey(cfg) : rawRequester;
    const includeCompleted = p.includeCompleted !== false;
    const rootConversationIdFilter =
      typeof p.rootConversationId === "string" ? p.rootConversationId.trim() : "";
    const threadIdFilter = typeof p.threadId === "string" ? p.threadId.trim() : "";
    const subagentGroupIdFilter =
      typeof p.subagentGroupId === "string" ? p.subagentGroupId.trim() : "";
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.min(200, Math.floor(p.limit)))
        : 50;

    const subagentRows = listSubagentRunsForRequester(requesterSessionKey).map(
      (entry): SubagentTaskRow => {
        const terminalOutcome = entry.outcome?.status;
        const status = !entry.endedAt
          ? "running"
          : terminalOutcome === "ok" || terminalOutcome == null
            ? "done"
            : "error";
        const runtimeMs =
          typeof entry.startedAt === "number"
            ? Math.max(0, (entry.endedAt ?? Date.now()) - entry.startedAt)
            : undefined;
        return {
          taskId: entry.runId,
          title: entry.label || entry.task || "subagent task",
          status,
          requesterSessionKey: entry.requesterSessionKey,
          source: "subagent",
          openable: true,
          assignedSessionKey: entry.childSessionKey,
          assignedRunId: entry.runId,
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          label: entry.label,
          task: entry.task,
          cleanup: entry.cleanup,
          model: entry.model,
          modelApplied: entry.modelApplied,
          routing: entry.routing,
          complexity: entry.complexity,
          rootConversationId: entry.rootConversationId,
          threadId: entry.threadId,
          parentRunId: entry.parentRunId,
          subagentGroupId: entry.subagentGroupId,
          taskPlanTaskId: entry.taskId,
          outcome: entry.outcome,
          createdAt: entry.createdAt,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          runtimeMs,
        };
      },
    );

    const rows = [
      ...subagentRows,
      ...listBackgroundCodingRowsForRequester(requesterSessionKey, includeCompleted),
    ]
      .toSorted((a, b) => {
        const aTime = a.startedAt ?? a.createdAt ?? 0;
        const bTime = b.startedAt ?? b.createdAt ?? 0;
        return bTime - aTime;
      })
      .filter((entry) => includeCompleted || !entry.endedAt)
      .filter((entry) => {
        if (rootConversationIdFilter && entry.rootConversationId !== rootConversationIdFilter) {
          return false;
        }
        if (threadIdFilter && entry.threadId !== threadIdFilter) {
          return false;
        }
        if (subagentGroupIdFilter && entry.subagentGroupId !== subagentGroupIdFilter) {
          return false;
        }
        return true;
      })
      .slice(0, limit);

    const active = rows.filter((row) => row.status === "running").length;
    const result: SessionsSubagentsResult = {
      ts: Date.now(),
      requesterSessionKey,
      count: rows.length,
      active,
      tasks: rows,
    };
    respond(true, result, undefined);
  },
  "sessions.spawn": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsSpawnParams, "sessions.spawn", respond)) {
      return;
    }

    const p = params;
    const cfg = loadConfig();
    const rawRequester = String(p.requesterSessionKey ?? "").trim();
    if (!rawRequester) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "requesterSessionKey required"),
      );
      return;
    }
    const requesterSessionKey = rawRequester === "main" ? resolveMainSessionKey(cfg) : rawRequester;

    const spawnTool = createSessionsSpawnTool({
      agentSessionKey: requesterSessionKey,
      agentChannel:
        typeof p.channel === "string" ? (p.channel as GatewayMessageChannel) : undefined,
      agentAccountId: typeof p.accountId === "string" ? p.accountId : undefined,
      agentTo: typeof p.to === "string" ? p.to : undefined,
      agentThreadId:
        typeof p.threadId === "string" || typeof p.threadId === "number" ? p.threadId : undefined,
      agentGroupId: typeof p.groupId === "string" ? p.groupId : undefined,
      agentGroupChannel: typeof p.groupChannel === "string" ? p.groupChannel : undefined,
      agentGroupSpace: typeof p.groupSpace === "string" ? p.groupSpace : undefined,
    });

    try {
      const spawnResult = await spawnTool.execute("gateway.sessions.spawn", {
        task: p.task,
        label: p.label,
        agentId: p.agentId,
        model: p.model,
        thinking: p.thinking,
        runTimeoutSeconds: p.runTimeoutSeconds,
        timeoutSeconds: p.timeoutSeconds,
        cleanup: p.cleanup,
        idempotencyKey: p.idempotencyKey,
        parentRunId: p.parentRunId,
        subagentGroupId: p.subagentGroupId,
        taskId: p.taskId,
      });
      const payload =
        spawnResult && typeof spawnResult === "object" && "details" in spawnResult
          ? (spawnResult.details as Record<string, unknown> | undefined)
          : undefined;
      respond(true, payload ?? { status: "error", error: "sessions.spawn failed" }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const hadExistingEntry = Boolean(entry);
    const commandReason = p.reason === "new" ? "new" : "reset";
    const hookEvent = createInternalHookEvent(
      "command",
      commandReason,
      target.canonicalKey ?? key,
      {
        sessionEntry: entry,
        previousSessionEntry: entry,
        commandSource: "gateway:sessions.reset",
        cfg,
      },
    );
    await triggerInternalHook(hookEvent);
    const sessionId = entry?.sessionId;
    const cleanupError = await ensureSessionRuntimeCleanup({ cfg, key, target, sessionId });
    if (cleanupError) {
      respond(false, undefined, cleanupError);
      return;
    }
    const acpCleanupError = await closeAcpRuntimeForSession({
      cfg,
      sessionKey: legacyKey ?? canonicalKey ?? target.canonicalKey ?? key,
      entry,
      reason: "session-reset",
    });
    if (acpCleanupError) {
      respond(false, undefined, acpCleanupError);
      return;
    }
    let oldSessionId: string | undefined;
    let oldSessionFile: string | undefined;
    const next = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const entry = store[primaryKey];
      const parsed = parseAgentSessionKey(primaryKey);
      const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
      const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
      oldSessionId = entry?.sessionId;
      oldSessionFile = entry?.sessionFile;
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        model: resolvedModel.model,
        modelProvider: resolvedModel.provider,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    // Archive old transcript so it doesn't accumulate on disk (#14869).
    archiveSessionTranscriptsForSession({
      sessionId: oldSessionId,
      storePath,
      sessionFile: oldSessionFile,
      agentId: target.agentId,
      reason: "reset",
    });
    if (hadExistingEntry) {
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-reset",
      });
    }
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const cleanupError = await ensureSessionRuntimeCleanup({ cfg, key, target, sessionId });
    if (cleanupError) {
      respond(false, undefined, cleanupError);
      return;
    }
    const acpCleanupError = await closeAcpRuntimeForSession({
      cfg,
      sessionKey: legacyKey ?? canonicalKey ?? target.canonicalKey ?? key,
      entry,
      reason: "session-delete",
    });
    if (acpCleanupError) {
      respond(false, undefined, acpCleanupError);
      return;
    }
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },
};
