import { getQueuedFileWriter, type QueuedFileWriter } from "../agents/queued-file-writer.js";
import { resolveEventsLogPath } from "../config/paths.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { registerLogTransport } from "./logger.js";

/**
 * Event name prefixes that are emitted as structured metadata on logger calls
 * (e.g. logger.debug("msg", { event: "memory.search", ... })) and should be
 * bridged into the canonical NDJSON observability sink.
 */
const STRUCTURED_LOG_EVENT_PREFIXES = ["memory.", "provider.endpoint."] as const;

let structuredLogTransportRegistered = false;

/**
 * Register a one-time log transport that intercepts any structured logger call
 * that carries a recognised `event` field and mirrors it into the NDJSON sink.
 * This bridges memory/DGX/reranker/Qdrant events without touching each call site.
 * Safe to call multiple times — installs at most once per process.
 */
export function registerStructuredEventObservabilityTransport(): void {
  if (structuredLogTransportRegistered) {
    return;
  }
  structuredLogTransportRegistered = true;

  registerLogTransport((logObj) => {
    const event = logObj["event"];
    if (typeof event !== "string") {
      return;
    }
    const matched = STRUCTURED_LOG_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
    if (!matched) {
      return;
    }

    // Extract envelope fields that may be present on the log object, then put
    // everything else (except tslog internals) into `data`.
    const {
      event: _event,
      phase,
      status,
      durationMs,
      error,
      agentId,
      sessionKey,
      // tslog internals — exclude from data blob
      _meta,
      date: _date,
      ...rest
    } = logObj as Record<string, unknown>;

    emitObservabilityEvent({
      event,
      component: event.startsWith("memory.") ? "memory" : "provider",
      agentId: typeof agentId === "string" ? agentId : undefined,
      sessionKey: typeof sessionKey === "string" ? sessionKey : undefined,
      status: typeof status === "string" ? status : typeof phase === "string" ? phase : undefined,
      durationMs: typeof durationMs === "number" ? durationMs : undefined,
      error: typeof error === "string" ? error : undefined,
      data: { phase, ...rest },
    });
  });
}

type ObservabilityEventData = Record<string, unknown>;

/**
 * Canonical runtime observability envelope. Events are appended as NDJSON to
 * `$OPENCLAW_STATE_DIR/logs/events/YYYY-MM-DD.ndjson` (default: `~/.openclaw/logs/events/...`).
 */
export type ObservabilityEventEnvelope<
  Data extends ObservabilityEventData = ObservabilityEventData,
> = {
  ts: string;
  event: string;
  component: string;
  agentId?: string;
  sessionKey?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  data?: Data;
};

export type ObservabilityEventInput<Data extends ObservabilityEventData = ObservabilityEventData> =
  {
    ts?: string | number | Date;
    event: string;
    component: string;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    status?: string;
    durationMs?: number;
    error?: string;
    data?: Data;
  };

type DiagnosticEventLike = {
  type: string;
  ts: number;
  seq: number;
  sessionKey?: string;
  durationMs?: unknown;
  error?: unknown;
  outcome?: unknown;
  state?: unknown;
  level?: unknown;
} & Record<string, unknown>;

const writers = new Map<string, QueuedFileWriter>();
let forceEnabledForTest = false;

function getWriter(filePath: string): QueuedFileWriter {
  return getQueuedFileWriter(writers, filePath);
}

function isObservabilitySinkEnabled(): boolean {
  return process.env.VITEST !== "true" || forceEnabledForTest;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeTimestamp(value: string | number | Date | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function normalizeEventData<Data extends ObservabilityEventData>(
  data: Data | undefined,
): Data | undefined {
  if (!data || Object.keys(data).length === 0) {
    return undefined;
  }
  return data;
}

function resolveAgentId(agentId: unknown, sessionKey: string | undefined): string | undefined {
  const explicit = normalizeOptionalString(agentId);
  if (explicit) {
    return explicit;
  }
  if (!sessionKey || !parseAgentSessionKey(sessionKey)) {
    return undefined;
  }
  return resolveAgentIdFromSessionKey(sessionKey);
}

function writeObservabilityEvent(event: ObservabilityEventEnvelope): void {
  if (!isObservabilitySinkEnabled()) {
    return;
  }
  const line = safeJsonStringify(event);
  if (!line) {
    return;
  }
  const filePath = resolveEventsLogPath(new Date(event.ts));
  getWriter(filePath).write(`${line}\n`);
}

export function createObservabilityEvent<
  Data extends ObservabilityEventData = ObservabilityEventData,
>(input: ObservabilityEventInput<Data>): ObservabilityEventEnvelope<Data> {
  const sessionKey = normalizeOptionalString(input.sessionKey);
  const timestamp = normalizeTimestamp(input.ts);
  return {
    ts: timestamp.toISOString(),
    event: input.event,
    component: input.component,
    agentId: resolveAgentId(input.agentId, sessionKey),
    sessionKey,
    traceId: normalizeOptionalString(input.traceId),
    spanId: normalizeOptionalString(input.spanId),
    parentSpanId: normalizeOptionalString(input.parentSpanId),
    status: normalizeOptionalString(input.status),
    durationMs: normalizeOptionalNumber(input.durationMs),
    error: normalizeOptionalString(input.error),
    data: normalizeEventData(input.data),
  };
}

export function emitObservabilityEvent<
  Data extends ObservabilityEventData = ObservabilityEventData,
>(input: ObservabilityEventInput<Data>): ObservabilityEventEnvelope<Data> {
  const event = createObservabilityEvent(input);
  writeObservabilityEvent(event);
  return event;
}

function resolveDiagnosticStatus(event: DiagnosticEventLike): string | undefined {
  const outcome = normalizeOptionalString(event.outcome);
  if (outcome) {
    return outcome;
  }
  const state = normalizeOptionalString(event.state);
  if (state) {
    return state;
  }
  switch (event.type) {
    case "webhook.received":
      return "received";
    case "webhook.processed":
      return "processed";
    case "webhook.error":
      return "error";
    case "message.queued":
    case "queue.lane.enqueue":
      return "queued";
    case "queue.lane.dequeue":
      return "dequeued";
    case "session.stuck":
      return "warning";
    case "diagnostic.heartbeat":
    case "model.usage":
      return "ok";
    default:
      return normalizeOptionalString(event.level);
  }
}

function createDiagnosticData(event: DiagnosticEventLike): ObservabilityEventData {
  const data: ObservabilityEventData = {
    seq: event.seq,
  };
  for (const [key, value] of Object.entries(event)) {
    if (
      key === "type" ||
      key === "ts" ||
      key === "seq" ||
      key === "sessionKey" ||
      key === "durationMs" ||
      key === "error"
    ) {
      continue;
    }
    data[key] = value;
  }
  return data;
}

export function emitDiagnosticObservabilityEvent(
  event: DiagnosticEventLike,
): ObservabilityEventEnvelope {
  return emitObservabilityEvent({
    ts: event.ts,
    event: event.type,
    component: "diagnostic",
    sessionKey: normalizeOptionalString(event.sessionKey),
    status: resolveDiagnosticStatus(event),
    durationMs: normalizeOptionalNumber(event.durationMs),
    error: normalizeOptionalString(event.error),
    data: createDiagnosticData(event),
  });
}

export async function flushObservabilityForTest(): Promise<void> {
  await Promise.all([...writers.values()].map((writer) => writer.flush()));
}

export function setObservabilityEnabledForTest(enabled: boolean): void {
  forceEnabledForTest = enabled;
}

export function resetObservabilityForTest(): void {
  forceEnabledForTest = false;
  writers.clear();
}
