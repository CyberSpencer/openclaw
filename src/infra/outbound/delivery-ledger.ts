import crypto from "node:crypto";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

export type DeliveryState = "queued" | "retrying" | "sent" | "failed" | "acknowledged";

export type DeliveryLedgerResult = {
  gatewayPayload?: Record<string, unknown>;
  sendAction?: {
    handledBy: "plugin" | "core";
    payload: unknown;
    sendResult?: unknown;
  };
};

export type DeliveryLedgerEvent = {
  state: DeliveryState;
  at: number;
  attempt: number;
  note?: string;
  error?: string;
  delayMs?: number;
};

export type DeliveryLedgerEntry = {
  id: string;
  idempotencyKey?: string;
  action: "send" | "poll";
  channel: DeliverableMessageChannel;
  to: string;
  payloadType: "text" | "media" | "mixed" | "poll" | "unknown";
  urgency: "low" | "normal" | "high" | "critical";
  state: DeliveryState;
  attempts: number;
  explicitChannel: boolean;
  routeReason?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  result?: DeliveryLedgerResult;
  events: DeliveryLedgerEvent[];
};

type RegisterDeliveryInput = {
  idempotencyKey?: string;
  action: "send" | "poll";
  channel: DeliverableMessageChannel;
  to: string;
  payloadType: DeliveryLedgerEntry["payloadType"];
  urgency: DeliveryLedgerEntry["urgency"];
  explicitChannel?: boolean;
  routeReason?: string;
};

type ListLedgerParams = {
  limit?: number;
  state?: DeliveryState;
  channel?: string;
  idempotencyKey?: string;
};

const ALLOWED_TRANSITIONS: Record<DeliveryState, Set<DeliveryState>> = {
  queued: new Set(["retrying", "sent", "failed", "acknowledged"]),
  retrying: new Set(["retrying", "sent", "failed", "acknowledged"]),
  sent: new Set(["acknowledged"]),
  failed: new Set(["retrying", "sent", "acknowledged"]),
  acknowledged: new Set(),
};

const DEFAULT_MAX_ENTRIES = 2_000;

const entriesById = new Map<string, DeliveryLedgerEntry>();
const entriesByIdempotency = new Map<string, string>();

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

function cloneEntry(entry: DeliveryLedgerEntry): DeliveryLedgerEntry {
  return {
    ...entry,
    events: entry.events.map((event) => cloneJson(event)),
    result: entry.result
      ? {
          gatewayPayload: cloneJson(entry.result.gatewayPayload),
          sendAction: entry.result.sendAction
            ? {
                ...entry.result.sendAction,
                payload: cloneJson(entry.result.sendAction.payload),
                sendResult: cloneJson(entry.result.sendAction.sendResult),
              }
            : undefined,
        }
      : undefined,
  };
}

function getMaxEntries(): number {
  const raw = Number(process.env.OPENCLAW_MESSAGE_LEDGER_MAX_ENTRIES ?? "");
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_ENTRIES;
  }
  return Math.max(100, Math.floor(raw));
}

function ensureCapacity() {
  const maxEntries = getMaxEntries();
  if (entriesById.size <= maxEntries) {
    return;
  }
  const ordered = Array.from(entriesById.values()).toSorted((a, b) => a.updatedAt - b.updatedAt);
  while (entriesById.size > maxEntries && ordered.length > 0) {
    const oldest = ordered.shift();
    if (!oldest) {
      break;
    }
    entriesById.delete(oldest.id);
    if (oldest.idempotencyKey) {
      const mappedId = entriesByIdempotency.get(oldest.idempotencyKey);
      if (mappedId === oldest.id) {
        entriesByIdempotency.delete(oldest.idempotencyKey);
      }
    }
  }
}

function isTransitionAllowed(from: DeliveryState, to: DeliveryState): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_TRANSITIONS[from].has(to);
}

function appendEvent(params: {
  entry: DeliveryLedgerEntry;
  state: DeliveryState;
  note?: string;
  error?: string;
  delayMs?: number;
}) {
  params.entry.events.push({
    state: params.state,
    at: Date.now(),
    attempt: params.entry.attempts,
    note: params.note,
    error: params.error,
    delayMs: params.delayMs,
  });
}

function transitionEntry(params: {
  id: string;
  next: DeliveryState;
  note?: string;
  error?: string;
  delayMs?: number;
  result?: DeliveryLedgerResult;
}): DeliveryLedgerEntry {
  const entry = entriesById.get(params.id);
  if (!entry) {
    throw new Error(`delivery ledger entry not found: ${params.id}`);
  }
  if (!isTransitionAllowed(entry.state, params.next)) {
    throw new Error(`invalid delivery ledger transition: ${entry.state} -> ${params.next}`);
  }
  if (params.next === "retrying") {
    entry.attempts += 1;
  }
  if (params.next === "failed" && entry.attempts === 0) {
    entry.attempts = 1;
  }
  if (params.next === "sent" && entry.attempts === 0) {
    entry.attempts = 1;
  }
  if (params.error) {
    entry.lastError = params.error;
  }
  if (params.result) {
    entry.result = params.result;
  }
  entry.state = params.next;
  entry.updatedAt = Date.now();
  appendEvent({
    entry,
    state: params.next,
    note: params.note,
    error: params.error,
    delayMs: params.delayMs,
  });
  return cloneEntry(entry);
}

export function registerDelivery(input: RegisterDeliveryInput): DeliveryLedgerEntry {
  const idem = input.idempotencyKey?.trim();
  if (idem) {
    const existingId = entriesByIdempotency.get(idem);
    const existing = existingId ? entriesById.get(existingId) : undefined;
    if (existing) {
      return cloneEntry(existing);
    }
  }

  const now = Date.now();
  const entry: DeliveryLedgerEntry = {
    id: crypto.randomUUID(),
    idempotencyKey: idem,
    action: input.action,
    channel: input.channel,
    to: input.to,
    payloadType: input.payloadType,
    urgency: input.urgency,
    state: "queued",
    attempts: 0,
    explicitChannel: input.explicitChannel === true,
    routeReason: input.routeReason,
    createdAt: now,
    updatedAt: now,
    events: [
      {
        state: "queued",
        at: now,
        attempt: 0,
        note: "queued",
      },
    ],
  };

  entriesById.set(entry.id, entry);
  if (idem) {
    entriesByIdempotency.set(idem, entry.id);
  }
  ensureCapacity();
  return cloneEntry(entry);
}

export function getDeliveryById(id: string): DeliveryLedgerEntry | null {
  const entry = entriesById.get(id);
  return entry ? cloneEntry(entry) : null;
}

export function getDeliveryByIdempotencyKey(idempotencyKey?: string): DeliveryLedgerEntry | null {
  const idem = idempotencyKey?.trim();
  if (!idem) {
    return null;
  }
  const id = entriesByIdempotency.get(idem);
  if (!id) {
    return null;
  }
  const entry = entriesById.get(id);
  return entry ? cloneEntry(entry) : null;
}

export function listDeliveries(params: ListLedgerParams = {}): DeliveryLedgerEntry[] {
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit ?? 50)));
  const idempotencyKey = params.idempotencyKey?.trim();
  const channel = params.channel?.trim().toLowerCase();
  return Array.from(entriesById.values())
    .filter((entry) => {
      if (params.state && entry.state !== params.state) {
        return false;
      }
      if (idempotencyKey && entry.idempotencyKey !== idempotencyKey) {
        return false;
      }
      if (channel && entry.channel.toLowerCase() !== channel) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((entry) => cloneEntry(entry));
}

export function markDeliveryRetrying(params: {
  id: string;
  error: string;
  delayMs: number;
}): DeliveryLedgerEntry {
  return transitionEntry({
    id: params.id,
    next: "retrying",
    note: "retrying",
    error: params.error,
    delayMs: params.delayMs,
  });
}

export function markDeliverySent(params: {
  id: string;
  note?: string;
  result?: DeliveryLedgerResult;
}): DeliveryLedgerEntry {
  return transitionEntry({
    id: params.id,
    next: "sent",
    note: params.note ?? "sent",
    result: params.result,
  });
}

export function markDeliveryFailed(params: {
  id: string;
  error: string;
  note?: string;
}): DeliveryLedgerEntry {
  return transitionEntry({
    id: params.id,
    next: "failed",
    note: params.note ?? "failed",
    error: params.error,
  });
}

export function markDeliveryAcknowledged(params: {
  id: string;
  note?: string;
}): DeliveryLedgerEntry {
  return transitionEntry({
    id: params.id,
    next: "acknowledged",
    note: params.note ?? "acknowledged",
  });
}

export function resetDeliveryLedgerForTests(): void {
  entriesById.clear();
  entriesByIdempotency.clear();
}
