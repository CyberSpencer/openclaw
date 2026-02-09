import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { buildSubagentSystemPrompt } from "../../agents/subagent-announce.js";
import { registerSubagentRun } from "../../agents/subagent-registry.js";
import { normalizeThinkLevel, formatThinkingLevels } from "../../auto-reply/thinking.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { agentCommand } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSpawnParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type { GatewayRequestHandlers } from "./types.js";

function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!validateSessionsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
        ),
      );
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
  "sessions.spawn": async ({ params, respond, context }) => {
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

    const p = params as {
      requesterSessionKey: string;
      task: string;
      label?: string;
      agentId?: string;
      model?: string;
      thinking?: string;
      runTimeoutSeconds?: number;
      timeoutSeconds?: number;
      cleanup?: "delete" | "keep";
      idempotencyKey?: string;
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
      groupId?: string;
      groupChannel?: string;
      groupSpace?: string;
    };

    const cfg = loadConfig();
    const mainKey = normalizeMainKey(cfg.session?.mainKey);
    const scope = cfg.session?.scope ?? "per-sender";
    const alias = scope === "global" ? "global" : mainKey;

    const requesterSessionKeyRaw = String(p.requesterSessionKey ?? "").trim();
    const requesterInternalKey = requesterSessionKeyRaw === "main" ? alias : requesterSessionKeyRaw;
    if (!requesterInternalKey) {
      respond(true, { status: "error", error: "requesterSessionKey required" }, undefined);
      return;
    }
    if (isSubagentSessionKey(requesterInternalKey)) {
      respond(
        true,
        {
          status: "forbidden",
          error: "sessions.spawn is not allowed from sub-agent sessions",
        },
        undefined,
      );
      return;
    }

    const requesterDisplayKey =
      requesterInternalKey === alias || requesterInternalKey === mainKey
        ? "main"
        : requesterInternalKey;

    const task = String(p.task ?? "").trim();
    if (!task) {
      respond(true, { status: "error", error: "task required" }, undefined);
      return;
    }

    const runTimeoutSeconds = (() => {
      const explicit =
        typeof p.runTimeoutSeconds === "number" && Number.isFinite(p.runTimeoutSeconds)
          ? Math.max(0, Math.floor(p.runTimeoutSeconds))
          : undefined;
      if (explicit !== undefined) {
        return explicit;
      }
      const legacy =
        typeof p.timeoutSeconds === "number" && Number.isFinite(p.timeoutSeconds)
          ? Math.max(0, Math.floor(p.timeoutSeconds))
          : undefined;
      return legacy ?? 0;
    })();

    const requesterOrigin = normalizeDeliveryContext({
      channel: typeof p.channel === "string" ? p.channel : undefined,
      accountId: typeof p.accountId === "string" ? p.accountId : undefined,
      to: typeof p.to === "string" ? p.to : undefined,
      threadId: p.threadId,
    });

    const requesterAgentId = normalizeAgentId(parseAgentSessionKey(requesterInternalKey)?.agentId);
    const requestedAgentIdRaw = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const targetAgentId = requestedAgentIdRaw
      ? normalizeAgentId(requestedAgentIdRaw)
      : requesterAgentId;

    if (targetAgentId !== requesterAgentId) {
      const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
      const allowAny = allowAgents.some((value) => String(value ?? "").trim() === "*");
      const normalizedTargetId = targetAgentId.toLowerCase();
      const allowSet = new Set(
        allowAgents
          .filter((value) => String(value ?? "").trim() && String(value ?? "").trim() !== "*")
          .map((value) => normalizeAgentId(String(value ?? "")).toLowerCase()),
      );
      if (!allowAny && !allowSet.has(normalizedTargetId)) {
        const allowedText = allowAny
          ? "*"
          : allowSet.size > 0
            ? Array.from(allowSet).join(", ")
            : "none";
        respond(
          true,
          {
            status: "forbidden",
            error: `agentId is not allowed for sessions.spawn (allowed: ${allowedText})`,
          },
          undefined,
        );
        return;
      }
    }

    const idempotencyKeyRaw =
      typeof p.idempotencyKey === "string" && p.idempotencyKey.trim()
        ? p.idempotencyKey.trim()
        : undefined;
    const childRunId = idempotencyKeyRaw ?? randomUUID();
    const cached = context.dedupe.get(`sessions.spawn:${childRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, { cached: true });
      return;
    }

    const childSessionKey = `agent:${targetAgentId}:subagent:${randomUUID()}`;
    const spawnedByKey = requesterInternalKey;
    const label = typeof p.label === "string" ? p.label.trim() : "";
    const cleanup = p.cleanup === "delete" || p.cleanup === "keep" ? p.cleanup : "keep";

    // Resolve default model selection for the child session.
    const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
    const modelOverride = typeof p.model === "string" ? p.model.trim() : "";
    const resolvedModel =
      (modelOverride ? modelOverride : undefined) ??
      normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
      normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

    // Validate thinking override.
    let thinkingOverride: string | undefined;
    const thinkingOverrideRaw = typeof p.thinking === "string" ? p.thinking.trim() : "";
    if (thinkingOverrideRaw) {
      const normalized = normalizeThinkLevel(thinkingOverrideRaw);
      if (!normalized) {
        const { provider, model } = splitModelRef(resolvedModel);
        const hint = formatThinkingLevels(provider, model);
        respond(
          true,
          {
            status: "error",
            error: `Invalid thinking level "${thinkingOverrideRaw}". Use one of: ${hint}.`,
          },
          undefined,
        );
        return;
      }
      thinkingOverride = normalized;
    }

    // Ensure the child session exists and is linked to its requester.
    const spawnedByPatch = await (async () => {
      const target = resolveGatewaySessionStoreTarget({ cfg, key: childSessionKey });
      const storePath = target.storePath;
      return await updateSessionStore(storePath, async (store) => {
        const primaryKey = target.storeKeys[0] ?? childSessionKey;
        const existingKey = target.storeKeys.find((candidate) => store[candidate]);
        if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
          store[primaryKey] = store[existingKey];
          delete store[existingKey];
        }
        return await applySessionsPatchToStore({
          cfg,
          store,
          storeKey: primaryKey,
          patch: {
            key: primaryKey,
            spawnedBy: spawnedByKey,
          },
          loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        });
      });
    })();
    if (!spawnedByPatch.ok) {
      respond(
        true,
        { status: "error", error: spawnedByPatch.error.message, childSessionKey },
        undefined,
      );
      return;
    }

    // Best-effort model patch for the child session.
    let modelWarning: string | undefined;
    let modelApplied = false;
    if (resolvedModel) {
      const patched = await (async () => {
        const target = resolveGatewaySessionStoreTarget({ cfg, key: childSessionKey });
        const storePath = target.storePath;
        return await updateSessionStore(storePath, async (store) => {
          const primaryKey = target.storeKeys[0] ?? childSessionKey;
          const existingKey = target.storeKeys.find((candidate) => store[candidate]);
          if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
            store[primaryKey] = store[existingKey];
            delete store[existingKey];
          }
          return await applySessionsPatchToStore({
            cfg,
            store,
            storeKey: primaryKey,
            patch: {
              key: primaryKey,
              model: resolvedModel,
            },
            loadGatewayModelCatalog: context.loadGatewayModelCatalog,
          });
        });
      })();

      if (patched.ok) {
        modelApplied = true;
      } else {
        const messageText = String(patched.error.message ?? "error");
        const recoverable =
          messageText.includes("invalid model") || messageText.includes("model not allowed");
        if (!recoverable) {
          respond(true, { status: "error", error: messageText, childSessionKey }, undefined);
          return;
        }
        modelWarning = messageText;
      }
    }

    const childSystemPrompt = buildSubagentSystemPrompt({
      requesterSessionKey: requesterDisplayKey,
      requesterOrigin,
      childSessionKey,
      label: label || undefined,
      task,
    });

    // Fire-and-forget background run.
    void agentCommand(
      {
        message: task,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        accountId: requesterOrigin?.accountId,
        to: requesterOrigin?.to,
        threadId: requesterOrigin?.threadId,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds > 0 ? String(runTimeoutSeconds) : undefined,
        runId: childRunId,
        spawnedBy: spawnedByKey,
        groupId: p.groupId ?? undefined,
        groupChannel: p.groupChannel ?? undefined,
        groupSpace: p.groupSpace ?? undefined,
      },
      defaultRuntime,
      context.deps,
    ).catch((err) => {
      context.logGateway.error(`sessions.spawn run failed: ${String(err)}`);
    });

    registerSubagentRun({
      runId: childRunId,
      childSessionKey,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      requesterDisplayKey,
      task,
      cleanup,
      label: label || undefined,
      runTimeoutSeconds,
    });

    const payload = {
      status: "accepted" as const,
      childSessionKey,
      runId: childRunId,
      modelApplied: resolvedModel ? modelApplied : undefined,
      warning: modelWarning,
    };
    context.dedupe.set(`sessions.spawn:${childRunId}`, {
      ts: Date.now(),
      ok: true,
      payload,
    });
    respond(true, payload, undefined, { runId: childRunId });
  },
  "sessions.preview": ({ params, respond }) => {
    if (!validateSessionsPreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.preview params: ${formatValidationErrors(
            validateSessionsPreviewParams.errors,
          )}`,
        ),
      );
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
        const target = resolveGatewaySessionStoreTarget({ cfg, key });
        const store = storeCache.get(target.storePath) ?? loadSessionStore(target.storePath);
        storeCache.set(target.storePath, store);
        const entry =
          target.storeKeys.map((candidate) => store[candidate]).find(Boolean) ??
          store[target.canonicalKey];
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
  "sessions.resolve": ({ params, respond }) => {
    if (!validateSessionsResolveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.resolve params: ${formatValidationErrors(validateSessionsResolveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context }) => {
    if (!validateSessionsPatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const applied = await updateSessionStore(storePath, async (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
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
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!validateSessionsResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    const next = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      const entry = store[primaryKey];
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
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond }) => {
    if (!validateSessionsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const cfg = loadConfig();
    const mainKey = resolveMainSessionKey(cfg);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const storePath = target.storePath;
    const { entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const existed = Boolean(entry);
    const queueKeys = new Set<string>(target.storeKeys);
    queueKeys.add(target.canonicalKey);
    if (sessionId) {
      queueKeys.add(sessionId);
    }
    clearSessionQueues([...queueKeys]);
    stopSubagentsForRequester({ cfg, requesterSessionKey: target.canonicalKey });
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
      const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
      if (!ended) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again in a moment.`,
          ),
        );
        return;
      }
    }
    await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      if (store[primaryKey]) {
        delete store[primaryKey];
      }
    });

    const archived: string[] = [];
    if (deleteTranscript && sessionId) {
      for (const candidate of resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
        target.agentId,
      )) {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        try {
          archived.push(archiveFileOnDisk(candidate, "deleted"));
        } catch {
          // Best-effort.
        }
      }
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted: existed, archived }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!validateSessionsCompactParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const storePath = target.storePath;
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? key;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);
      if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
        store[primaryKey] = store[existingKey];
        delete store[existingKey];
      }
      return { entry: store[primaryKey], primaryKey };
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
