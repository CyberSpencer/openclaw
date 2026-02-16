import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
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
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
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
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
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

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
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

function normalizeLineageValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectTaskPlanLineageWarnings(params: {
  requesterSessionKey: string;
  requesterRootConversationId?: string;
  requesterThreadId?: string;
  taskPlan: unknown;
}): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return warnings;
  }
  const recordRuns = listSubagentRunsForRequester(requesterSessionKey);
  if (recordRuns.length === 0) {
    return warnings;
  }

  const taskPlan = params.taskPlan as { tasks?: unknown } | undefined;
  const tasks = Array.isArray(taskPlan?.tasks) ? taskPlan.tasks : [];

  const taskRoots = new Set<string>();
  const taskThreads = new Set<string>();
  const mismatchedTasks: string[] = [];

  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      continue;
    }
    const t = task as Record<string, unknown>;
    const taskId = normalizeLineageValue(t.id) || "unknown";
    const assignedRunId = normalizeLineageValue(t.assignedRunId);
    const assignedSessionKey = normalizeLineageValue(t.assignedSessionKey);

    const matched = recordRuns.find((entry) => {
      if (assignedRunId && entry.runId === assignedRunId) {
        return true;
      }
      if (assignedSessionKey && entry.childSessionKey === assignedSessionKey) {
        return true;
      }
      return false;
    });
    if (!matched) {
      continue;
    }

    const rootConversationId = normalizeLineageValue(matched.rootConversationId);
    const threadId = normalizeLineageValue(matched.threadId);
    if (rootConversationId) {
      taskRoots.add(rootConversationId);
    }
    if (threadId) {
      taskThreads.add(threadId);
    }

    const requesterRoot = normalizeLineageValue(params.requesterRootConversationId);
    const requesterThread = normalizeLineageValue(params.requesterThreadId);
    const rootMismatch =
      requesterRoot && rootConversationId && requesterRoot !== rootConversationId;
    const threadMismatch = requesterThread && threadId && requesterThread !== threadId;
    if (rootMismatch || threadMismatch) {
      mismatchedTasks.push(taskId);
    }
  }

  if (taskRoots.size > 1) {
    warnings.push({
      type: "task_plan_lineage_mixed_root",
      requesterSessionKey,
      roots: Array.from(taskRoots),
    });
  }
  if (taskThreads.size > 1) {
    warnings.push({
      type: "task_plan_lineage_mixed_thread",
      requesterSessionKey,
      threads: Array.from(taskThreads),
    });
  }
  if (mismatchedTasks.length > 0) {
    warnings.push({
      type: "task_plan_lineage_requester_mismatch",
      requesterSessionKey,
      taskIds: mismatchedTasks,
      requesterRootConversationId:
        normalizeLineageValue(params.requesterRootConversationId) || undefined,
      requesterThreadId: normalizeLineageValue(params.requesterThreadId) || undefined,
    });
  }

  return warnings;
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
    if (!validateSessionsSubagentsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.subagents params: ${formatValidationErrors(validateSessionsSubagentsParams.errors)}`,
        ),
      );
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

    const rows = listSubagentRunsForRequester(requesterSessionKey)
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
      .slice(0, limit)
      .map((entry): SubagentTaskRow => {
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
          runId: entry.runId,
          assignedRunId: entry.runId,
          childSessionKey: entry.childSessionKey,
          assignedSessionKey: entry.childSessionKey,
          requesterSessionKey: entry.requesterSessionKey,
          label: entry.label,
          task: entry.task,
          status,
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
      });

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
    if (!validateSessionsSpawnParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.spawn params: ${formatValidationErrors(validateSessionsSpawnParams.errors)}`,
        ),
      );
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
  "sessions.patch": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
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

    if (p.taskPlan && applied.entry?.taskPlan) {
      const lineageWarnings = collectTaskPlanLineageWarnings({
        requesterSessionKey: target.canonicalKey,
        requesterRootConversationId: applied.entry.rootConversationId,
        requesterThreadId:
          typeof applied.entry.threadId === "string"
            ? applied.entry.threadId
            : typeof applied.entry.threadId === "number"
              ? String(applied.entry.threadId)
              : undefined,
        taskPlan: applied.entry.taskPlan,
      });
      for (const warning of lineageWarnings) {
        context.logGateway.warn(`sessions.patch lineage warning: ${JSON.stringify(warning)}`);
      }
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
    const { entry } = loadSessionEntry(key);
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
    let oldSessionId: string | undefined;
    let oldSessionFile: string | undefined;
    const next = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const entry = store[primaryKey];
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
        model: entry?.model,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        rootConversationId: deriveDefaultRootConversationId(primaryKey),
        threadId:
          typeof entry?.threadId === "string"
            ? entry.threadId
            : typeof entry?.threadId === "number" && Number.isFinite(entry.threadId)
              ? String(entry.threadId)
              : undefined,
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
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
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

    const { entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const existed = Boolean(entry);
    const cleanupError = await ensureSessionRuntimeCleanup({ cfg, key, target, sessionId });
    if (cleanupError) {
      respond(false, undefined, cleanupError);
      return;
    }
    await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      if (store[primaryKey]) {
        delete store[primaryKey];
      }
    });

    const archived = deleteTranscript
      ? archiveSessionTranscriptsForSession({
          sessionId,
          storePath,
          sessionFile: entry?.sessionFile,
          agentId: target.agentId,
          reason: "deleted",
        })
      : [];

    respond(true, { ok: true, key: target.canonicalKey, deleted: existed, archived }, undefined);
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
