import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import type { OpenClawApp } from "./app.ts";
import { createChatModelOverride } from "./chat-model-ref.ts";
import type { ChatModelOverride } from "./chat-model-ref.ts";
import { loadChatThreads } from "./controllers/chat-threads.ts";
import {
  abortChatRun,
  deliverChatSteer,
  loadChatHistory,
  sendChatMessage,
  steerChatMessage,
} from "./controllers/chat.ts";
import { loadModels } from "./controllers/models.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { ModelCatalogEntry, SessionsListResult } from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  chatMessages: unknown[];
  lastError: string | null;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  chatThreadsLoading: boolean;
  chatThreadsResult: SessionsListResult | null;
  chatThreadsError: string | null;
  chatThreadsQuery: string;
  refreshSessionsAfterChat: Set<string>;
  resetToolStream: () => void;
};

function parseModelCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith("/model")) {
    return null;
  }
  const rest = trimmed.slice("/model".length).trim();
  return rest;
}

async function applyChatModelCommand(host: ChatHost, rawModel: string) {
  if (!host.client || !host.connected) {
    return;
  }
  const trimmed = rawModel.trim();
  let nextValue = trimmed;
  if (trimmed && !trimmed.includes("/")) {
    const catalog = host.chatModelCatalog.length
      ? host.chatModelCatalog
      : await loadModels(host.client).catch(() => []);
    const match = catalog.find((entry) => entry.id.trim().toLowerCase() === trimmed.toLowerCase());
    if (match?.provider) {
      nextValue = `${match.provider}/${match.id}`;
    }
  }
  await host.client.request("sessions.patch", {
    key: host.sessionKey,
    model: trimmed || null,
  });
  host.chatModelOverrides = {
    ...host.chatModelOverrides,
    [host.sessionKey]: createChatModelOverride(nextValue),
  };
  await loadSessions(host as unknown as OpenClawApp, {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
  });
}

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  await abortChatRun(host as unknown as OpenClawApp);
}

function enqueueChatMessage(host: ChatHost, text: string, attachments?: ChatAttachment[]) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  host.resetToolStream?.();
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  return ok;
}

async function steerChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: { previousDraft?: string },
) {
  const idempotencyKey = generateUUID();
  const res = await steerChatMessage(host as unknown as OpenClawApp, message, { idempotencyKey });
  const ok = Boolean(res && res.ok);
  const status = res?.status ?? null;
  if (ok && status && status !== "steered" && status !== "compacting") {
    (host as unknown as { lastError: string | null }).lastError =
      `Steer not delivered (${status}).`;
  }
  if (ok && status === "compacting") {
    void enqueueCompactionSteerRetry(host, message, idempotencyKey);
  }
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  return ok;
}

type PendingSteer = {
  text: string;
  idempotencyKey: string;
  enqueuedAt: number;
};

const compactionSteerBacklogs = new Map<string, PendingSteer[]>();
const compactionSteerWorkers = new Map<string, Promise<void>>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function backoffMs(attempt: number) {
  return Math.min(2500, 200 + attempt * 200);
}

async function enqueueCompactionSteerRetry(
  host: ChatHost,
  message: string,
  idempotencyKey: string,
) {
  const sessionKey = host.sessionKey;
  if (!sessionKey) {
    return;
  }
  const text = message.trim();
  if (!text) {
    return;
  }
  const key = idempotencyKey.trim();
  if (!key) {
    return;
  }

  const backlog = compactionSteerBacklogs.get(sessionKey) ?? [];
  backlog.push({ text, idempotencyKey: key, enqueuedAt: Date.now() });
  compactionSteerBacklogs.set(sessionKey, backlog);

  if (compactionSteerWorkers.has(sessionKey)) {
    return;
  }

  const worker = runCompactionSteerWorker(host, sessionKey);
  compactionSteerWorkers.set(sessionKey, worker);
  void worker.finally(() => {
    compactionSteerWorkers.delete(sessionKey);
  });
}

async function runCompactionSteerWorker(host: ChatHost, sessionKey: string): Promise<void> {
  const maxMessageWaitMs = 3 * 60_000;

  while (true) {
    if (!host.connected) {
      return;
    }
    if (host.sessionKey !== sessionKey) {
      await sleep(500);
      continue;
    }

    const backlog = compactionSteerBacklogs.get(sessionKey) ?? [];
    const next = backlog[0];
    if (!next) {
      compactionSteerBacklogs.delete(sessionKey);
      return;
    }

    if (Date.now() - next.enqueuedAt > maxMessageWaitMs) {
      (host as unknown as { lastError: string | null }).lastError =
        "Steer not delivered (timed out waiting for compaction).";
      backlog.shift();
      compactionSteerBacklogs.set(sessionKey, backlog);
      continue;
    }

    let attempt = 0;
    while (true) {
      if (!host.connected) {
        return;
      }
      if (host.sessionKey !== sessionKey) {
        break;
      }

      attempt += 1;
      await sleep(backoffMs(attempt));

      const res = await deliverChatSteer(
        host as unknown as OpenClawApp,
        next.text,
        next.idempotencyKey,
      );
      const ok = Boolean(res && res.ok);
      const status = res?.status ?? null;
      if (!ok) {
        backlog.shift();
        compactionSteerBacklogs.set(sessionKey, backlog);
        break;
      }
      if (status === "steered") {
        backlog.shift();
        compactionSteerBacklogs.set(sessionKey, backlog);
        break;
      }
      if (status === "compacting") {
        continue;
      }

      (host as unknown as { lastError: string | null }).lastError =
        `Steer not delivered (${status}).`;
      backlog.shift();
      compactionSteerBacklogs.set(sessionKey, backlog);
      break;
    }
  }
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean; forceQueue?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }
  const modelCommand = parseModelCommand(message);
  if (modelCommand != null) {
    try {
      await applyChatModelCommand(host, modelCommand);
    } catch (err) {
      host.lastError = String(err);
    }
    if (messageOverride == null) {
      host.chatMessage = "";
      host.chatAttachments = [];
    }
    return;
  }
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    // While a run is active, default to steering (injecting) text-only messages so Spencer can
    // correct/redirect mid-run. Attachments can't be steered today, so those fall back to queue.
    const shouldQueue =
      Boolean(opts?.forceQueue) || messageOverride != null || attachmentsToSend.length > 0;
    if (shouldQueue) {
      enqueueChatMessage(host, message, attachmentsToSend);
      return;
    }
    await steerChatMessageNow(host, message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
    });
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
  });
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    }),
    loadChatThreads(host as unknown as Parameters<typeof loadChatThreads>[0], {
      search: host.chatThreadsQuery,
    }),
    refreshChatAvatar(host),
    refreshChatModels(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

async function refreshChatModels(host: ChatHost) {
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  host.chatModelsLoading = true;
  try {
    host.chatModelCatalog = await loadModels(host.client);
  } finally {
    host.chatModelsLoading = false;
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
