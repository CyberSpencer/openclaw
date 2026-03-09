/**
 * Spark voice STT/TTS gateway methods.
 *
 * Standalone from PersonaPlex. Calls DGX-hosted STT and TTS services
 * when Spark is enabled and reachable. Fails cleanly when Spark is down.
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  appendUrlPath,
  mergeDgxRequestHeaders,
  parseStringLike,
  resolveDgxAccess,
  resolveDgxEnabled,
  resolveEffectiveEnv,
  resolveWanServiceBaseUrl,
  type DgxAccessContext,
} from "./dgx-access.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const MIN_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_STT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TTS_TEXT_CHARS = 12_000;
const DEFAULT_TTS_STREAM_PATH = "v1/synthesize/stream";
const DEFAULT_TTS_CANCEL_PATH = "v1/cancel";
const SPARK_STREAM_EVENT_STARTED = "spark.voice.stream.started";
const SPARK_STREAM_EVENT_CHUNK = "spark.voice.stream.chunk";
const SPARK_STREAM_EVENT_COMPLETED = "spark.voice.stream.completed";
const SPARK_STREAM_EVENT_ERROR = "spark.voice.stream.error";

type ActiveSparkTtsStream = {
  controller: AbortController;
  turnId?: string;
  cancelledByClient: boolean;
};

const activeSparkTtsStreams = new Map<string, ActiveSparkTtsStream>();
const activeSparkTtsByTurnId = new Map<string, Set<string>>();

type SparkStreamEmitContext = Pick<
  GatewayRequestContext,
  "broadcast" | "broadcastToConnIds" | "nodeSendToSession"
>;

function emitSparkVoiceStreamEvent(params: {
  context: SparkStreamEmitContext;
  client: GatewayClient | null;
  sessionKey?: string;
  event: string;
  payload: Record<string, unknown>;
}): void {
  const connId =
    typeof params.client?.connId === "string" && params.client.connId.trim()
      ? params.client.connId.trim()
      : null;
  if (connId) {
    params.context.broadcastToConnIds(params.event, params.payload, new Set([connId]), {
      dropIfSlow: true,
    });
  } else {
    params.context.broadcast(params.event, params.payload, { dropIfSlow: true });
  }
  if (params.sessionKey) {
    params.context.nodeSendToSession(params.sessionKey, params.event, params.payload);
  }
}

function resolveTtsTimeoutMs(env: Record<string, string>): number {
  const raw =
    parseStringLike(env.DGX_TTS_TIMEOUT_MS) ?? parseStringLike(process.env.DGX_TTS_TIMEOUT_MS);
  if (!raw) {
    return DEFAULT_TTS_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TTS_TIMEOUT_MS;
  }
  return Math.max(MIN_TTS_TIMEOUT_MS, parsed);
}

function resolveSttMaxBodyBytes(env: Record<string, string>): number {
  const raw =
    parseStringLike(env.VOICE_STT_MAX_BODY_BYTES) ??
    parseStringLike(process.env.VOICE_STT_MAX_BODY_BYTES);
  if (!raw) {
    return DEFAULT_STT_MAX_BODY_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STT_MAX_BODY_BYTES;
  }
  return Math.max(1, Math.trunc(parsed));
}

function resolvePort(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTtsStreamPath(env: Record<string, string>): string {
  const configured =
    parseStringLike(env.DGX_TTS_STREAM_PATH) ?? parseStringLike(process.env.DGX_TTS_STREAM_PATH);
  return configured ?? DEFAULT_TTS_STREAM_PATH;
}

function resolveTtsCancelPath(env: Record<string, string>): string {
  const configured =
    parseStringLike(env.DGX_TTS_CANCEL_PATH) ?? parseStringLike(process.env.DGX_TTS_CANCEL_PATH);
  return configured ?? DEFAULT_TTS_CANCEL_PATH;
}

function resolveSparkVoiceUrls(
  env: Record<string, string>,
  context: DgxAccessContext,
):
  | {
      sttUrl: string;
      ttsUrl: string;
      ttsStreamUrl: string;
      ttsCancelUrl: string;
      voicesUrl: string;
    }
  | undefined {
  const ttsStreamPath = resolveTtsStreamPath(env);
  const ttsCancelPath = resolveTtsCancelPath(env);
  if (context.mode === "wan") {
    const sttBase = resolveWanServiceBaseUrl(context, "voiceStt");
    const ttsBase = resolveWanServiceBaseUrl(context, "voiceTts");
    if (!sttBase || !ttsBase) {
      return undefined;
    }
    return {
      sttUrl: appendUrlPath(sttBase, "v1/transcribe"),
      ttsUrl: appendUrlPath(ttsBase, "v1/synthesize"),
      ttsStreamUrl: appendUrlPath(ttsBase, ttsStreamPath),
      ttsCancelUrl: appendUrlPath(ttsBase, ttsCancelPath),
      voicesUrl: appendUrlPath(ttsBase, "v1/voices"),
    };
  }

  const host = context.lanHost;
  if (!host) {
    return undefined;
  }
  const sttPort = resolvePort(
    parseStringLike(env.DGX_STT_PORT) ?? parseStringLike(process.env.DGX_STT_PORT),
    DEFAULT_STT_PORT,
  );
  const ttsPort = resolvePort(
    parseStringLike(env.DGX_TTS_PORT) ?? parseStringLike(process.env.DGX_TTS_PORT),
    DEFAULT_TTS_PORT,
  );
  return {
    sttUrl: `http://${host}:${sttPort}/v1/transcribe`,
    ttsUrl: `http://${host}:${ttsPort}/v1/synthesize`,
    ttsStreamUrl: `http://${host}:${ttsPort}/${ttsStreamPath.replace(/^\/+/, "")}`,
    ttsCancelUrl: `http://${host}:${ttsPort}/${ttsCancelPath.replace(/^\/+/, "")}`,
    voicesUrl: `http://${host}:${ttsPort}/v1/voices`,
  };
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeHeaderValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function getResponseHeader(
  response: { headers?: { get?: (name: string) => string | null } } | null | undefined,
  name: string,
): string | undefined {
  if (!response) {
    return undefined;
  }
  try {
    const value = response.headers?.get?.(name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

type SparkCorrelationMeta = {
  requestId: string;
  turnId?: string;
  conversationId?: string;
  sessionKey?: string;
  clientMessageId?: string;
  source?: string;
};

function resolveSparkCorrelationMeta(
  params: Record<string, unknown> | undefined,
  fallbackRequestId: string,
): SparkCorrelationMeta {
  const requestId = asTrimmedString(params?.requestId) ?? fallbackRequestId;
  return {
    requestId,
    turnId: asTrimmedString(params?.turnId),
    conversationId: asTrimmedString(params?.conversationId),
    sessionKey: asTrimmedString(params?.sessionKey),
    clientMessageId: asTrimmedString(params?.clientMessageId),
    source: asTrimmedString(params?.source),
  };
}

function buildSparkCorrelationHeaders(
  baseHeaders: Record<string, string>,
  correlation: SparkCorrelationMeta,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseHeaders,
    "x-request-id": correlation.requestId,
  };
  const turnId = normalizeHeaderValue(correlation.turnId);
  const conversationId = normalizeHeaderValue(correlation.conversationId);
  const sessionKey = normalizeHeaderValue(correlation.sessionKey);
  const clientMessageId = normalizeHeaderValue(correlation.clientMessageId);
  const source = normalizeHeaderValue(correlation.source);
  if (turnId) {
    headers["x-turn-id"] = turnId;
  }
  if (conversationId) {
    headers["x-conversation-id"] = conversationId;
  }
  if (sessionKey) {
    headers["x-session-key"] = sessionKey;
  }
  if (clientMessageId) {
    headers["x-client-message-id"] = clientMessageId;
  }
  if (source) {
    headers["x-source"] = source;
  }
  return headers;
}

function registerActiveSparkTtsStream(streamId: string, active: ActiveSparkTtsStream): void {
  activeSparkTtsStreams.set(streamId, active);
  if (!active.turnId) {
    return;
  }
  const streamIds = activeSparkTtsByTurnId.get(active.turnId) ?? new Set<string>();
  streamIds.add(streamId);
  activeSparkTtsByTurnId.set(active.turnId, streamIds);
}

function unregisterActiveSparkTtsStream(streamId: string): void {
  const active = activeSparkTtsStreams.get(streamId);
  if (!active) {
    return;
  }
  activeSparkTtsStreams.delete(streamId);
  if (!active.turnId) {
    return;
  }
  const streamIds = activeSparkTtsByTurnId.get(active.turnId);
  if (!streamIds) {
    return;
  }
  streamIds.delete(streamId);
  if (streamIds.size === 0) {
    activeSparkTtsByTurnId.delete(active.turnId);
  }
}

function resolveStreamIdsForCancel(streamId?: string, turnId?: string): string[] {
  const explicit = streamId?.trim();
  if (explicit) {
    return [explicit];
  }
  const key = turnId?.trim();
  if (!key) {
    return [];
  }
  return [...(activeSparkTtsByTurnId.get(key) ?? new Set<string>())];
}

type SparkTtsStreamChunk = {
  audioBase64: string;
  format: string;
  sampleRate?: number;
  isLast?: boolean;
  chunkDurationMs?: number;
};

function asBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (["true", "1", "yes", "y", "done", "completed"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeSparkTtsStreamChunk(
  value: unknown,
  fallbackFormat: string,
): SparkTtsStreamChunk | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const audioBase64 = asTrimmedString(record.audio_base64) ?? asTrimmedString(record.audioBase64);
  if (!audioBase64) {
    return null;
  }
  const format = asTrimmedString(record.format) ?? fallbackFormat;
  const sampleRateRaw = record.sample_rate ?? record.sampleRate;
  const sampleRate =
    typeof sampleRateRaw === "number" && Number.isFinite(sampleRateRaw)
      ? Math.max(1, Math.trunc(sampleRateRaw))
      : undefined;
  const isLast =
    asBooleanLike(record.isLast) ??
    asBooleanLike(record.is_last) ??
    asBooleanLike(record.last) ??
    asBooleanLike(record.final);
  const chunkDurationRaw = record.chunkDurationMs ?? record.chunk_duration_ms;
  const chunkDurationMs = normalizeTimingNumber(chunkDurationRaw);
  return {
    audioBase64,
    format,
    sampleRate,
    ...(typeof isLast === "boolean" ? { isLast } : {}),
    ...(chunkDurationMs != null
      ? { chunkDurationMs: Math.max(0, Math.round(chunkDurationMs)) }
      : {}),
  };
}

function resolveSparkTtsStreamChunks(
  result: Record<string, unknown>,
  fallbackFormat: string,
): SparkTtsStreamChunk[] {
  const chunkListRaw = Array.isArray(result.chunks)
    ? result.chunks
    : Array.isArray(result.audio_chunks)
      ? result.audio_chunks
      : null;
  if (chunkListRaw) {
    const normalized = chunkListRaw
      .map((entry) => normalizeSparkTtsStreamChunk(entry, fallbackFormat))
      .filter((entry): entry is SparkTtsStreamChunk => entry != null);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  const single = normalizeSparkTtsStreamChunk(result, fallbackFormat);
  return single ? [single] : [];
}

function isStreamingContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/event-stream") ||
    normalized.includes("application/x-ndjson") ||
    normalized.includes("application/ndjson")
  );
}

function normalizeSparkStreamKind(
  raw: string | undefined,
): "started" | "chunk" | "completed" | "error" | null {
  if (!raw) {
    return null;
  }
  const kind = raw.trim().toLowerCase();
  if (!kind) {
    return null;
  }
  if (kind.includes("error") || kind.includes("fail")) {
    return "error";
  }
  if (kind.includes("complete") || kind.includes("done") || kind.includes("finish")) {
    return "completed";
  }
  if (kind.includes("chunk") || kind.includes("audio")) {
    return "chunk";
  }
  if (kind.includes("start")) {
    return "started";
  }
  return null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveSparkStreamRecord(
  rawEventName: string | undefined,
  rawRecord: Record<string, unknown>,
  fallbackFormat: string,
  nextSeq: number,
): {
  kind: "started" | "chunk" | "completed" | "error";
  payload: Record<string, unknown>;
  nextSeq: number;
} | null {
  const eventName =
    rawEventName ??
    asTrimmedString(rawRecord.event) ??
    asTrimmedString(rawRecord.type) ??
    asTrimmedString(rawRecord.kind) ??
    asTrimmedString(rawRecord.status);
  const nestedError =
    rawRecord.error && typeof rawRecord.error === "object"
      ? (rawRecord.error as Record<string, unknown>)
      : null;
  const doneFlag =
    asBooleanLike(rawRecord.done) ??
    asBooleanLike(rawRecord.completed) ??
    asBooleanLike(rawRecord.complete) ??
    asBooleanLike(rawRecord.final) ??
    false;
  const hasCompletionMetadata =
    normalizeTimingNumber(rawRecord.totalChunks ?? rawRecord.total_chunks) != null ||
    normalizeTimingNumber(rawRecord.durationMs ?? rawRecord.duration_ms) != null;
  const hasErrorShape =
    typeof rawRecord.error === "string" ||
    nestedError != null ||
    asTrimmedString(rawRecord.message) != null ||
    asTrimmedString(rawRecord.code) != null;
  let kind = normalizeSparkStreamKind(eventName);
  if (!kind) {
    if (doneFlag || hasCompletionMetadata) {
      kind = "completed";
    } else if (hasErrorShape) {
      kind = "error";
    }
  }

  const normalizedChunk =
    normalizeSparkTtsStreamChunk(rawRecord.chunk, fallbackFormat) ??
    normalizeSparkTtsStreamChunk(rawRecord, fallbackFormat);
  if (!kind && normalizedChunk) {
    const seqRaw = rawRecord.seq ?? rawRecord.index ?? rawRecord.chunk_index;
    const seq =
      typeof seqRaw === "number" && Number.isFinite(seqRaw)
        ? Math.max(1, Math.trunc(seqRaw))
        : nextSeq;
    return {
      kind: "chunk",
      payload: {
        seq,
        audioBase64: normalizedChunk.audioBase64,
        format: normalizedChunk.format,
        sampleRate: normalizedChunk.sampleRate,
        ...(typeof normalizedChunk.isLast === "boolean" ? { isLast: normalizedChunk.isLast } : {}),
        ...(typeof normalizedChunk.chunkDurationMs === "number"
          ? { chunkDurationMs: normalizedChunk.chunkDurationMs }
          : {}),
      },
      nextSeq: Math.max(nextSeq, seq + 1),
    };
  }

  if (kind === "started") {
    return {
      kind,
      payload: {},
      nextSeq,
    };
  }

  if (kind === "chunk") {
    if (!normalizedChunk) {
      return null;
    }
    const seqRaw = rawRecord.seq ?? rawRecord.index ?? rawRecord.chunk_index;
    const seq =
      typeof seqRaw === "number" && Number.isFinite(seqRaw)
        ? Math.max(1, Math.trunc(seqRaw))
        : nextSeq;
    return {
      kind,
      payload: {
        seq,
        audioBase64: normalizedChunk.audioBase64,
        format: normalizedChunk.format,
        sampleRate: normalizedChunk.sampleRate,
        ...(typeof normalizedChunk.isLast === "boolean" ? { isLast: normalizedChunk.isLast } : {}),
        ...(typeof normalizedChunk.chunkDurationMs === "number"
          ? { chunkDurationMs: normalizedChunk.chunkDurationMs }
          : {}),
      },
      nextSeq: Math.max(nextSeq, seq + 1),
    };
  }

  if (kind === "completed") {
    const totalChunksRaw = rawRecord.totalChunks ?? rawRecord.total_chunks;
    const durationMsRaw = rawRecord.durationMs ?? rawRecord.duration_ms;
    const totalChunks = normalizeTimingNumber(totalChunksRaw);
    const durationMs = normalizeTimingNumber(durationMsRaw);
    return {
      kind,
      payload: {
        totalChunks: totalChunks != null ? Math.max(0, Math.trunc(totalChunks)) : undefined,
        durationMs: durationMs != null ? Math.max(0, Math.round(durationMs)) : undefined,
      },
      nextSeq,
    };
  }

  if (kind === "error") {
    const message =
      asTrimmedString(rawRecord.message) ??
      asTrimmedString(nestedError?.message) ??
      (typeof rawRecord.error === "string" ? rawRecord.error.trim() : "") ??
      "Spark TTS stream failed.";
    const code = asTrimmedString(rawRecord.code) ?? asTrimmedString(nestedError?.code);
    return {
      kind,
      payload: {
        ...(code ? { code } : {}),
        message,
      },
      nextSeq,
    };
  }

  return null;
}

async function consumeSparkTtsStreamResponse(params: {
  context: SparkStreamEmitContext;
  client: GatewayClient | null;
  sessionKey?: string;
  conversationId?: string;
  turnId?: string;
  streamId: string;
  fallbackFormat: string;
  response: Response;
  startedAt: number;
}): Promise<{ chunkCount: number; completed: boolean; errored: boolean }> {
  let chunkCount = 0;
  let completed = false;
  let errored = false;
  let nextSeq = 1;

  const emitChunk = (payload: Record<string, unknown>) => {
    chunkCount += 1;
    emitSparkVoiceStreamEvent({
      context: params.context,
      client: params.client,
      sessionKey: params.sessionKey,
      event: SPARK_STREAM_EVENT_CHUNK,
      payload: {
        streamId: params.streamId,
        sessionKey: params.sessionKey,
        conversationId: params.conversationId,
        turnId: params.turnId,
        ...payload,
        ts: Date.now(),
      },
    });
  };

  const emitCompleted = (payload: Record<string, unknown> = {}) => {
    completed = true;
    emitSparkVoiceStreamEvent({
      context: params.context,
      client: params.client,
      sessionKey: params.sessionKey,
      event: SPARK_STREAM_EVENT_COMPLETED,
      payload: {
        streamId: params.streamId,
        sessionKey: params.sessionKey,
        conversationId: params.conversationId,
        turnId: params.turnId,
        totalChunks:
          typeof payload.totalChunks === "number" && Number.isFinite(payload.totalChunks)
            ? Math.max(0, Math.trunc(payload.totalChunks))
            : chunkCount,
        durationMs:
          typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
            ? Math.max(0, Math.round(payload.durationMs))
            : Date.now() - params.startedAt,
        ts: Date.now(),
      },
    });
  };

  const emitError = (payload: Record<string, unknown>) => {
    errored = true;
    emitSparkVoiceStreamEvent({
      context: params.context,
      client: params.client,
      sessionKey: params.sessionKey,
      event: SPARK_STREAM_EVENT_ERROR,
      payload: {
        streamId: params.streamId,
        sessionKey: params.sessionKey,
        conversationId: params.conversationId,
        turnId: params.turnId,
        ...payload,
        ts: Date.now(),
      },
    });
  };

  const consumeRecord = (eventName: string | undefined, record: Record<string, unknown>) => {
    const normalized = resolveSparkStreamRecord(eventName, record, params.fallbackFormat, nextSeq);
    if (!normalized) {
      return;
    }
    nextSeq = normalized.nextSeq;
    if (normalized.kind === "chunk") {
      emitChunk(normalized.payload);
      return;
    }
    if (normalized.kind === "completed") {
      emitCompleted(normalized.payload);
      return;
    }
    if (normalized.kind === "error") {
      emitError(normalized.payload);
    }
  };

  const contentType = getResponseHeader(params.response, "content-type") ?? null;
  if (!isStreamingContentType(contentType)) {
    const json = (await params.response.json()) as Record<string, unknown>;
    const chunks = resolveSparkTtsStreamChunks(json, params.fallbackFormat);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      emitChunk({
        seq: index + 1,
        audioBase64: chunk.audioBase64,
        format: chunk.format,
        sampleRate: chunk.sampleRate,
        ...(typeof chunk.isLast === "boolean" ? { isLast: chunk.isLast } : {}),
        ...(typeof chunk.chunkDurationMs === "number"
          ? { chunkDurationMs: chunk.chunkDurationMs }
          : {}),
      });
    }
    if (chunks.length > 0 && !completed && !errored) {
      emitCompleted({ totalChunks: chunks.length });
    }
    return { chunkCount, completed, errored };
  }

  const reader = params.response.body?.getReader();
  if (!reader) {
    return { chunkCount, completed, errored };
  }

  const decoder = new TextDecoder();
  const useSse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  let buffer = "";

  const consumeSseBuffer = (flush: boolean) => {
    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex < 0) {
        if (flush && buffer.trim()) {
          const block = buffer;
          buffer = "";
          consumeSseBlock(block);
        }
        return;
      }
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      consumeSseBlock(block);
    }
  };

  const consumeSseBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) {
      return;
    }
    const json = parseJsonObject(dataLines.join("\n"));
    if (!json) {
      return;
    }
    consumeRecord(eventName, json);
  };

  const consumeNdjsonBuffer = (flush: boolean) => {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        if (flush && buffer.trim()) {
          const json = parseJsonObject(buffer.trim());
          if (json) {
            consumeRecord(undefined, json);
          }
          buffer = "";
        }
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const json = parseJsonObject(line);
      if (!json) {
        continue;
      }
      consumeRecord(undefined, json);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    buffer += decoder.decode(value, { stream: true });
    if (useSse) {
      consumeSseBuffer(false);
    } else {
      consumeNdjsonBuffer(false);
    }
  }
  buffer += decoder.decode();
  if (useSse) {
    consumeSseBuffer(true);
  } else {
    consumeNdjsonBuffer(true);
  }

  if (!completed && !errored && chunkCount > 0) {
    emitCompleted({ totalChunks: chunkCount });
  }

  return { chunkCount, completed, errored };
}

function normalizeTimingNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Number(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return undefined;
}

function toWholeMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function extractDgxTotalMs(result: Record<string, unknown>): number | undefined {
  const timings = result.timings_ms;
  if (!timings || typeof timings !== "object") {
    return undefined;
  }
  return normalizeTimingNumber((timings as Record<string, unknown>).total_ms);
}

function resolveRequestId(
  outboundRequestId: string,
  response: Response,
  result: Record<string, unknown>,
): string {
  const fromBody = asTrimmedString(result.request_id);
  if (fromBody) {
    return fromBody;
  }
  const fromHeader = asTrimmedString(getResponseHeader(response, "x-request-id"));
  if (fromHeader) {
    return fromHeader;
  }
  return outboundRequestId;
}

function resolvePayloadTooLargeError(
  maxBytes: number,
  receivedBytes: number,
): {
  code: "VOICE_STT_PAYLOAD_TOO_LARGE";
  max_bytes: number;
  received_bytes: number;
  message: string;
} {
  return {
    code: "VOICE_STT_PAYLOAD_TOO_LARGE",
    max_bytes: maxBytes,
    received_bytes: Math.max(0, Math.trunc(receivedBytes)),
    message: "Audio payload exceeds max size.",
  };
}

function resolveSparkTtsDefaults(env: Record<string, string>): {
  voice?: string;
  speaker?: string;
  language?: string;
  instruct?: string;
  format?: string;
} {
  const cfg = loadConfig();
  const defaults = cfg.voice?.sparkTts;
  return {
    voice: asTrimmedString(defaults?.voice) ?? parseStringLike(env.SPARK_TTS_DEFAULT_VOICE),
    speaker: asTrimmedString(defaults?.speaker) ?? parseStringLike(env.SPARK_TTS_DEFAULT_SPEAKER),
    language:
      asTrimmedString(defaults?.language) ?? parseStringLike(env.SPARK_TTS_DEFAULT_LANGUAGE),
    instruct:
      asTrimmedString(defaults?.instruct) ?? parseStringLike(env.SPARK_TTS_DEFAULT_INSTRUCT),
    format: asTrimmedString(defaults?.format) ?? parseStringLike(env.SPARK_TTS_DEFAULT_FORMAT),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const sparkVoiceHandlers: GatewayRequestHandlers = {
  /**
   * Speech-to-text via Spark.
   * Request: { audio_base64: string; format?: string; sample_rate?: number; language?: string }
   * Response: {
   *   text: string;
   *   confidence?: number;
   *   language_detected?: string;
   *   request_id?: string;
   *   timings_ms?: {
   *     gateway_receive_ms: number;
   *     gateway_proxy_outbound_ms: number;
   *     gateway_wait_dgx_ms: number;
   *     gateway_serialize_send_ms: number;
   *     gateway_total_ms: number;
   *     dgx_total_ms?: number;
   *   };
   * }
   */
  "spark.voice.stt": async ({ respond, params }) => {
    try {
      const gatewayStartedAt = Date.now();
      const env = resolveEffectiveEnv();
      if (!resolveDgxEnabled(env)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Spark is not enabled"));
        return;
      }

      const access = await resolveDgxAccess(env);
      if (!access.context) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, access.error ?? "DGX endpoint is not configured"),
        );
        return;
      }

      const urls = resolveSparkVoiceUrls(env, access.context);
      if (!urls) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Spark voice endpoints are not configured"),
        );
        return;
      }

      const audioBase64 = params?.audio_base64;
      if (typeof audioBase64 !== "string" || !audioBase64) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "audio_base64 is required"),
        );
        return;
      }

      const correlation = resolveSparkCorrelationMeta(params, randomUUID());
      const body = {
        audio_base64: audioBase64,
        format: asTrimmedString(params?.format) ?? "webm",
        sample_rate:
          typeof params?.sample_rate === "number" && Number.isFinite(params.sample_rate)
            ? Math.max(8_000, Math.trunc(params.sample_rate))
            : 16_000,
        language: asTrimmedString(params?.language) ?? "en",
      };

      const serializedBody = JSON.stringify(body);
      const payloadBytes = Buffer.byteLength(serializedBody, "utf8");
      const maxBodyBytes = resolveSttMaxBodyBytes(env);
      if (payloadBytes > maxBodyBytes) {
        const tooLarge = resolvePayloadTooLargeError(maxBodyBytes, payloadBytes);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, tooLarge.message, {
            details: tooLarge,
          }),
        );
        return;
      }

      const requestId = correlation.requestId;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const formatLog = body.format ?? "webm";
      const sampleRateLog = body.sample_rate ?? 16_000;
      console.warn(
        `[spark-voice] STT request: request_id=${requestId} format=${formatLog} sample_rate=${sampleRateLog} payload_bytes=${payloadBytes}`,
      );

      try {
        const gatewayReceiveMs = Date.now() - gatewayStartedAt;
        const proxyStartedAt = Date.now();
        const responsePromise = fetch(urls.sttUrl, {
          method: "POST",
          headers: mergeDgxRequestHeaders(
            access.context,
            buildSparkCorrelationHeaders(
              {
                "content-type": "application/json",
                accept: "application/json",
              },
              correlation,
            ),
          ),
          body: serializedBody,
          signal: controller.signal,
        });
        const proxyDispatchedAt = Date.now();
        const response = await responsePromise;
        const gatewayWaitDgxMs = Date.now() - proxyDispatchedAt;

        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          console.warn(
            `[spark-voice] STT HTTP ${response.status}: request_id=${requestId} ${bodyText.slice(0, 200)}`,
          );

          let parsedJson: Record<string, unknown> | null = null;
          try {
            parsedJson = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            parsedJson = null;
          }

          const detail =
            typeof parsedJson?.detail === "string"
              ? parsedJson.detail
              : parsedJson && typeof parsedJson.error === "object"
                ? asTrimmedString((parsedJson.error as Record<string, unknown>).message)
                : "";

          if (response.status === 413) {
            const parsedError =
              parsedJson && parsedJson.error && typeof parsedJson.error === "object"
                ? (parsedJson.error as Record<string, unknown>)
                : null;
            const maxBytes =
              normalizeTimingNumber(parsedError?.max_bytes) ??
              normalizeTimingNumber(parsedJson?.max_bytes) ??
              maxBodyBytes;
            const receivedBytes =
              normalizeTimingNumber(parsedError?.received_bytes) ??
              normalizeTimingNumber(parsedJson?.received_bytes) ??
              payloadBytes;

            const tooLarge = resolvePayloadTooLargeError(maxBytes, receivedBytes);
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, tooLarge.message, {
                details: tooLarge,
              }),
            );
            return;
          }

          if (response.status === 400) {
            const parsedError =
              parsedJson && parsedJson.error && typeof parsedJson.error === "object"
                ? (parsedJson.error as Record<string, unknown>)
                : null;
            const message =
              (parsedError ? asTrimmedString(parsedError.message) : undefined) ??
              detail ??
              "Spark STT request is invalid.";
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                message,
                parsedError ? { details: parsedError } : {},
              ),
            );
            return;
          }

          const msg = detail
            ? `Spark STT (${response.status}): ${detail}`
            : `Spark STT returned HTTP ${response.status}`;
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
          return;
        }

        const serializeStartedAt = Date.now();
        const result = (await response.json()) as Record<string, unknown>;
        const text = result.text ?? "";
        const dgxTotalMs = extractDgxTotalMs(result);
        const mergedRequestId = resolveRequestId(requestId, response, result);

        const gatewaySerializeSendMs = Date.now() - serializeStartedAt;
        const gatewayTotalMs = Date.now() - gatewayStartedAt;
        const gatewayProxyOutboundMs = proxyDispatchedAt - proxyStartedAt;

        console.warn(
          `[spark-voice] STT success: request_id=${mergedRequestId} text_len=${typeof text === "string" ? text.length : 0} gateway_total_ms=${gatewayTotalMs}`,
        );
        respond(true, {
          text,
          confidence: result.confidence,
          language_detected: result.language_detected,
          request_id: mergedRequestId,
          ...(correlation.turnId ? { turn_id: correlation.turnId } : {}),
          timings_ms: {
            gateway_receive_ms: toWholeMs(gatewayReceiveMs),
            gateway_proxy_outbound_ms: toWholeMs(gatewayProxyOutboundMs),
            gateway_wait_dgx_ms: toWholeMs(gatewayWaitDgxMs),
            gateway_serialize_send_ms: toWholeMs(gatewaySerializeSendMs),
            gateway_total_ms: toWholeMs(gatewayTotalMs),
            ...(dgxTotalMs != null ? { dgx_total_ms: toWholeMs(dgxTotalMs) } : {}),
          },
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[spark-voice] STT failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Spark STT failed: ${message}`));
    }
  },

  /**
   * Text-to-speech via Spark.
   * Request: { text: string; voice?: string; speaker?: string; language?: string; instruct?: string; style_prompt?: string; format?: string }
   * Response: { audio_base64: string; format?: string; sample_rate?: number }
   */
  "spark.voice.tts": async ({ respond, params }) => {
    try {
      const env = resolveEffectiveEnv();
      if (!resolveDgxEnabled(env)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Spark is not enabled"));
        return;
      }

      const access = await resolveDgxAccess(env);
      if (!access.context) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, access.error ?? "DGX endpoint is not configured"),
        );
        return;
      }

      const urls = resolveSparkVoiceUrls(env, access.context);
      if (!urls) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Spark voice endpoints are not configured"),
        );
        return;
      }

      const text = params?.text;
      if (typeof text !== "string" || !text.trim()) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text is required"));
        return;
      }
      const correlation = resolveSparkCorrelationMeta(params, randomUUID());
      const normalizedText = text.trim();
      if (normalizedText.length > MAX_TTS_TEXT_CHARS) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `text exceeds max length (${MAX_TTS_TEXT_CHARS} chars)`,
          ),
        );
        return;
      }

      const defaults = resolveSparkTtsDefaults(env);
      const speaker = asTrimmedString(params?.speaker) ?? defaults.speaker;
      const voice =
        asTrimmedString(params?.voice) ??
        speaker ??
        defaults.voice ??
        defaults.speaker ??
        "default";
      const language = asTrimmedString(params?.language) ?? defaults.language;
      const instruct =
        asTrimmedString(params?.instruct) ??
        asTrimmedString(params?.style_prompt) ??
        defaults.instruct;
      const format = asTrimmedString(params?.format) ?? defaults.format ?? "webm";
      const body = {
        text: normalizedText,
        voice,
        speaker: speaker ?? voice,
        language,
        instruct,
        format,
        ...(correlation.turnId ? { turn_id: correlation.turnId } : {}),
      };

      const ttsTimeoutMs = resolveTtsTimeoutMs(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ttsTimeoutMs);

      try {
        const response = await fetch(urls.ttsUrl, {
          method: "POST",
          headers: mergeDgxRequestHeaders(
            access.context,
            buildSparkCorrelationHeaders(
              {
                "content-type": "application/json",
                accept: "application/json",
              },
              correlation,
            ),
          ),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          let detail = "";
          try {
            const parsed = JSON.parse(bodyText) as Record<string, unknown>;
            detail = typeof parsed?.detail === "string" ? parsed.detail : "";
          } catch {
            /* not JSON */
          }
          const msg = detail
            ? `Spark TTS (${response.status}): ${detail}`
            : `Spark TTS returned HTTP ${response.status}`;
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
          return;
        }

        const result = (await response.json()) as Record<string, unknown>;
        const mergedRequestId = resolveRequestId(correlation.requestId, response, result);
        respond(true, {
          audio_base64: result.audio_base64 ?? "",
          format: result.format,
          sample_rate: result.sample_rate,
          request_id: mergedRequestId,
          ...(asTrimmedString(result.turn_id) ? { turn_id: asTrimmedString(result.turn_id) } : {}),
          ...(correlation.turnId ? { turn_id: correlation.turnId } : {}),
          ...(result.timings_ms && typeof result.timings_ms === "object"
            ? { timings_ms: result.timings_ms }
            : {}),
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const isAborted =
        (err instanceof Error && err.name === "AbortError") ||
        rawMessage.toLowerCase().includes("aborted");
      const env = resolveEffectiveEnv();
      const timeoutSec = Math.round(resolveTtsTimeoutMs(env) / 1000);
      const message = isAborted
        ? `TTS timed out after ${timeoutSec}s. DGX may be busy or the message is long.`
        : rawMessage;
      const textParam = params?.text;
      const textLen = typeof textParam === "string" ? textParam.trim().length : 0;
      const access = await resolveDgxAccess(env);
      const ttsUrl = access.context
        ? resolveSparkVoiceUrls(env, access.context)?.ttsUrl
        : undefined;
      const urlSafe = ttsUrl ? ttsUrl.replace(/\/\/[^:]+/, "//***") : "unknown";
      const timestamp = new Date().toISOString();
      console.warn(
        `[spark-voice] TTS failed: ts=${timestamp} textLen=${textLen} url=${urlSafe} timeoutSec=${timeoutSec} aborted=${isAborted}`,
      );
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Spark TTS failed: ${message}`));
    }
  },

  /**
   * Event-streamed text-to-speech via Spark.
   * Request: { text: string; streamId?: string; sessionKey?: string; conversationId?: string; turnId?: string; ...tts fields }
   * Response (ack): { streamId: string; accepted: true }
   * Events:
   * - spark.voice.stream.started
   * - spark.voice.stream.chunk
   * - spark.voice.stream.completed
   * - spark.voice.stream.error
   */
  "spark.voice.tts.stream": async ({ respond, params, context, client }) => {
    const streamId = asTrimmedString(params?.streamId) ?? randomUUID();
    const sessionKey = asTrimmedString(params?.sessionKey);
    const conversationId = asTrimmedString(params?.conversationId);
    const turnId = asTrimmedString(params?.turnId);
    const clientMessageId = asTrimmedString(params?.clientMessageId);
    const env = resolveEffectiveEnv();
    const correlation = resolveSparkCorrelationMeta(
      {
        ...params,
        sessionKey,
        conversationId,
        turnId,
        clientMessageId,
      },
      randomUUID(),
    );

    if (!resolveDgxEnabled(env)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Spark is not enabled"));
      return;
    }

    const text = params?.text;
    if (typeof text !== "string" || !text.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text is required"));
      return;
    }
    const normalizedText = text.trim();
    if (normalizedText.length > MAX_TTS_TEXT_CHARS) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `text exceeds max length (${MAX_TTS_TEXT_CHARS} chars)`,
        ),
      );
      return;
    }

    const access = await resolveDgxAccess(env);
    if (!access.context) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, access.error ?? "DGX endpoint is not configured"),
      );
      return;
    }

    const urls = resolveSparkVoiceUrls(env, access.context);
    if (!urls) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Spark voice endpoints are not configured"),
      );
      return;
    }

    const defaults = resolveSparkTtsDefaults(env);
    const speaker = asTrimmedString(params?.speaker) ?? defaults.speaker;
    const voice =
      asTrimmedString(params?.voice) ?? speaker ?? defaults.voice ?? defaults.speaker ?? "default";
    const language = asTrimmedString(params?.language) ?? defaults.language;
    const instruct =
      asTrimmedString(params?.instruct) ??
      asTrimmedString(params?.style_prompt) ??
      defaults.instruct;
    const format = asTrimmedString(params?.format) ?? defaults.format ?? "webm";
    const body = {
      text: normalizedText,
      voice,
      speaker: speaker ?? voice,
      language,
      instruct,
      format,
      stream_id: streamId,
      ...(turnId ? { turn_id: turnId } : {}),
    };
    const fallbackBody: Record<string, unknown> = { ...body };
    delete fallbackBody.stream_id;

    respond(true, {
      streamId,
      accepted: true,
      sessionKey,
      conversationId,
      turnId,
    });

    const startedAt = Date.now();
    emitSparkVoiceStreamEvent({
      context,
      client,
      sessionKey,
      event: SPARK_STREAM_EVENT_STARTED,
      payload: {
        streamId,
        sessionKey,
        conversationId,
        turnId,
        format,
        ts: startedAt,
      },
    });

    const ttsTimeoutMs = resolveTtsTimeoutMs(env);
    const controller = new AbortController();
    const activeStream: ActiveSparkTtsStream = {
      controller,
      turnId,
      cancelledByClient: false,
    };
    registerActiveSparkTtsStream(streamId, activeStream);
    const timer = setTimeout(() => controller.abort(), ttsTimeoutMs);

    const emitStreamError = (code: string, message: string) => {
      emitSparkVoiceStreamEvent({
        context,
        client,
        sessionKey,
        event: SPARK_STREAM_EVENT_ERROR,
        payload: {
          streamId,
          sessionKey,
          conversationId,
          turnId,
          code,
          message,
          ts: Date.now(),
        },
      });
    };

    const streamHeaders = mergeDgxRequestHeaders(
      access.context,
      buildSparkCorrelationHeaders(
        {
          "content-type": "application/json",
          accept: "text/event-stream, application/x-ndjson, application/json",
        },
        correlation,
      ),
    );
    if (streamId) {
      streamHeaders["x-stream-id"] = streamId;
    }
    const fallbackHeaders = mergeDgxRequestHeaders(
      access.context,
      buildSparkCorrelationHeaders(
        {
          "content-type": "application/json",
          accept: "application/json",
        },
        correlation,
      ),
    );
    if (streamId) {
      fallbackHeaders["x-stream-id"] = streamId;
    }

    const emitFallbackChunks = async (): Promise<boolean> => {
      const response = await fetch(urls.ttsUrl, {
        method: "POST",
        headers: fallbackHeaders,
        body: JSON.stringify(fallbackBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        let detail = "";
        const parsed = parseJsonObject(bodyText);
        if (parsed) {
          detail =
            asTrimmedString(parsed.detail) ??
            asTrimmedString((parsed.error as Record<string, unknown> | undefined)?.message) ??
            "";
        }
        const message = detail
          ? `Spark TTS (${response.status}): ${detail}`
          : `Spark TTS returned HTTP ${response.status}`;
        emitStreamError("SPARK_TTS_HTTP_ERROR", message);
        return false;
      }

      const result = (await response.json()) as Record<string, unknown>;
      const streamChunks = resolveSparkTtsStreamChunks(result, format);
      if (streamChunks.length === 0) {
        emitStreamError("SPARK_TTS_EMPTY_AUDIO", "Spark TTS returned empty audio payload.");
        return false;
      }

      streamChunks.forEach((chunk, index) => {
        emitSparkVoiceStreamEvent({
          context,
          client,
          sessionKey,
          event: SPARK_STREAM_EVENT_CHUNK,
          payload: {
            streamId,
            sessionKey,
            conversationId,
            turnId,
            seq: index + 1,
            audioBase64: chunk.audioBase64,
            format: chunk.format,
            sampleRate: chunk.sampleRate,
            ...(typeof chunk.isLast === "boolean" ? { isLast: chunk.isLast } : {}),
            ...(typeof chunk.chunkDurationMs === "number"
              ? { chunkDurationMs: chunk.chunkDurationMs }
              : {}),
            ts: Date.now(),
          },
        });
      });
      emitSparkVoiceStreamEvent({
        context,
        client,
        sessionKey,
        event: SPARK_STREAM_EVENT_COMPLETED,
        payload: {
          streamId,
          sessionKey,
          conversationId,
          turnId,
          totalChunks: streamChunks.length,
          durationMs: Date.now() - startedAt,
          ts: Date.now(),
        },
      });
      return true;
    };

    try {
      const streamResponse = await fetch(urls.ttsStreamUrl, {
        method: "POST",
        headers: streamHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let shouldFallback = false;
      if (!streamResponse.ok) {
        if ([404, 405, 406, 415, 501].includes(streamResponse.status)) {
          shouldFallback = true;
        } else {
          const bodyText = await streamResponse.text().catch(() => "");
          const parsed = parseJsonObject(bodyText);
          const detail =
            asTrimmedString(parsed?.detail) ??
            asTrimmedString((parsed?.error as Record<string, unknown> | undefined)?.message) ??
            "";
          const message = detail
            ? `Spark TTS stream (${streamResponse.status}): ${detail}`
            : `Spark TTS stream returned HTTP ${streamResponse.status}`;
          emitStreamError("SPARK_TTS_STREAM_HTTP_ERROR", message);
          return;
        }
      } else {
        const consumed = await consumeSparkTtsStreamResponse({
          context,
          client,
          sessionKey,
          conversationId,
          turnId,
          streamId,
          fallbackFormat: format,
          response: streamResponse,
          startedAt,
        });
        if (consumed.errored) {
          return;
        }
        if (consumed.chunkCount === 0) {
          shouldFallback = true;
        }
      }

      if (shouldFallback) {
        await emitFallbackChunks();
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const isAborted =
        (err instanceof Error && err.name === "AbortError") ||
        rawMessage.toLowerCase().includes("aborted");
      const cancelledByClient = activeStream.cancelledByClient;
      if (cancelledByClient) {
        emitStreamError("SPARK_TTS_CANCELLED", "Spark TTS stream cancelled.");
      } else if (isAborted) {
        const timeoutSec = Math.round(resolveTtsTimeoutMs(env) / 1000);
        emitStreamError("SPARK_TTS_TIMEOUT", `TTS stream timed out after ${timeoutSec}s.`);
      } else {
        emitStreamError("SPARK_TTS_STREAM_FAILED", `Spark TTS stream failed: ${rawMessage}`);
      }
    } finally {
      clearTimeout(timer);
      unregisterActiveSparkTtsStream(streamId);
    }
  },

  /**
   * Best-effort cancel for active Spark TTS stream work.
   * Request: { streamId?: string; turnId?: string; sessionKey?: string; conversationId?: string }
   */
  "spark.voice.tts.cancel": async ({ respond, params }) => {
    const streamId = asTrimmedString(params?.streamId);
    const turnId = asTrimmedString(params?.turnId);
    const sessionKey = asTrimmedString(params?.sessionKey);
    const conversationId = asTrimmedString(params?.conversationId);
    const env = resolveEffectiveEnv();
    const targetStreamIds = resolveStreamIdsForCancel(streamId, turnId);
    const cancelledStreamIds: string[] = [];

    for (const id of targetStreamIds) {
      const active = activeSparkTtsStreams.get(id);
      if (!active) {
        continue;
      }
      active.cancelledByClient = true;
      active.controller.abort();
      cancelledStreamIds.push(id);
    }

    const correlation = resolveSparkCorrelationMeta(
      {
        ...params,
        streamId,
        turnId,
        sessionKey,
        conversationId,
      },
      randomUUID(),
    );
    const access = await resolveDgxAccess(env);
    const urls = access.context ? resolveSparkVoiceUrls(env, access.context) : undefined;
    let remoteCancelAttempted = false;
    let remoteCancelOk: boolean | null = null;

    if (urls?.ttsCancelUrl && resolveDgxEnabled(env)) {
      remoteCancelAttempted = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const cancelResponse = await fetch(urls.ttsCancelUrl, {
          method: "POST",
          headers: mergeDgxRequestHeaders(
            access.context,
            (() => {
              const headers = buildSparkCorrelationHeaders(
                {
                  "content-type": "application/json",
                  accept: "application/json",
                },
                correlation,
              );
              if (streamId) {
                headers["x-stream-id"] = streamId;
              }
              return headers;
            })(),
          ),
          body: JSON.stringify({
            ...(streamId ? { stream_id: streamId } : {}),
            ...(turnId ? { turn_id: turnId } : {}),
          }),
          signal: controller.signal,
        });
        remoteCancelOk = cancelResponse.ok;
      } catch {
        remoteCancelOk = false;
      } finally {
        clearTimeout(timer);
      }
    }

    respond(true, {
      cancelled: cancelledStreamIds.length > 0 || remoteCancelOk === true,
      cancelledStreamIds,
      remoteCancelAttempted,
      remoteCancelOk,
    });
  },

  /**
   * List available Spark TTS voices.
   * Response: { voices: unknown[] }
   */
  "spark.voice.voices": async ({ respond }) => {
    try {
      const env = resolveEffectiveEnv();
      if (!resolveDgxEnabled(env)) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Spark is not enabled"));
        return;
      }

      const access = await resolveDgxAccess(env);
      if (!access.context) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, access.error ?? "DGX endpoint is not configured"),
        );
        return;
      }
      const urls = resolveSparkVoiceUrls(env, access.context);
      if (!urls) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Spark voice endpoints are not configured"),
        );
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(urls.voicesUrl, {
          method: "GET",
          headers: mergeDgxRequestHeaders(access.context, { accept: "application/json" }),
          signal: controller.signal,
        });
        if (!response.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Spark voices returned HTTP ${response.status}`),
          );
          return;
        }
        const result = (await response.json()) as unknown;
        const payload = result as Record<string, unknown>;
        const voices = Array.isArray(result)
          ? result
          : Array.isArray(payload?.voices)
            ? payload.voices
            : Array.isArray(payload?.speakers)
              ? payload.speakers
              : [];
        respond(true, { voices });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Spark voices failed: ${message}`),
      );
    }
  },
};
