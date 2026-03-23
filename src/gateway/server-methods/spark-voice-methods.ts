import { randomUUID } from "node:crypto";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveFetch } from "../../infra/fetch.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return null;
  }
  return v as Record<string, unknown>;
}

function readDgxConfig(config: OpenClawConfig): {
  wanBaseUrl: string;
  wanHeaders: Record<string, string>;
} {
  const raw = (config as { dgx?: unknown }).dgx;
  const rec = asRecord(raw);
  const wanBaseUrl =
    typeof rec?.wanBaseUrl === "string" ? rec.wanBaseUrl.trim().replace(/\/$/, "") : "";
  const wh = rec?.wanHeaders;
  const wanHeaders: Record<string, string> = {};
  if (wh && typeof wh === "object" && !Array.isArray(wh)) {
    for (const [k, v] of Object.entries(wh)) {
      if (typeof v === "string") {
        wanHeaders[k] = v;
      }
    }
  }
  return { wanBaseUrl, wanHeaders };
}

const DEFAULT_TTS_STREAM_PATH = "/v1/synthesize/stream";
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const MIN_TTS_TIMEOUT_MS = 30_000;

type SparkTtsStreamControl = {
  controller: AbortController;
  connId: string;
  streamId: string;
  startedAtMs: number;
  sessionKey?: string;
  conversationId?: string;
  turnId?: string;
};

type SparkTtsStreamParserState = {
  pending: string;
  sseEvent?: string;
  sseData: string[];
};

type SparkTtsStreamFrame = {
  event?: string;
  data: string;
};

type ParsedSparkTtsStreamEvent =
  | { kind: "chunk"; audioBase64: string; format?: string; sampleRate?: number }
  | { kind: "end" }
  | { kind: "error"; message: string };

const activeSparkTtsStreams = new Map<string, SparkTtsStreamControl>();

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }
  const timeoutMs = init.timeoutMs ?? 8000;
  const { timeoutMs: _t, ...rest } = init;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function ttsBases(
  config: OpenClawConfig,
): Array<{ url: string; headers?: Record<string, string> }> {
  const host = process.env.DGX_HOST?.trim() || "";
  const ttsPort = process.env.DGX_TTS_PORT?.trim() || "9002";
  const { wanBaseUrl, wanHeaders } = readDgxConfig(config);
  const out: Array<{ url: string; headers?: Record<string, string> }> = [];
  if (host) {
    out.push({ url: `http://${host}:${ttsPort}` });
  }
  if (wanBaseUrl) {
    out.push({
      url: wanBaseUrl,
      headers: Object.keys(wanHeaders).length ? wanHeaders : undefined,
    });
  }
  return out;
}

function resolveSparkTtsStreamPath(): string {
  const raw = process.env.DGX_TTS_STREAM_PATH?.trim();
  if (!raw) {
    return DEFAULT_TTS_STREAM_PATH;
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function resolveSparkTtsTimeoutMs(): number {
  const raw = process.env.DGX_TTS_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TTS_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TTS_TIMEOUT_MS;
  }
  return Math.max(MIN_TTS_TIMEOUT_MS, Math.trunc(parsed));
}

function createParserState(): SparkTtsStreamParserState {
  return { pending: "", sseData: [] };
}

function drainStreamFrames(
  state: SparkTtsStreamParserState,
  chunkText: string,
): SparkTtsStreamFrame[] {
  state.pending += chunkText;
  const frames: SparkTtsStreamFrame[] = [];

  while (true) {
    const idx = state.pending.indexOf("\n");
    if (idx < 0) {
      break;
    }

    let line = state.pending.slice(0, idx);
    state.pending = state.pending.slice(idx + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    const trimmed = line.trim();
    if (!trimmed) {
      if (state.sseData.length > 0) {
        frames.push({ event: state.sseEvent, data: state.sseData.join("\n") });
        state.sseData = [];
        state.sseEvent = undefined;
      }
      continue;
    }

    if (line.startsWith("event:")) {
      state.sseEvent = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      state.sseData.push(line.slice("data:".length).trim());
      continue;
    }
    if (line.startsWith(":")) {
      continue;
    }

    frames.push({ data: trimmed });
  }

  return frames;
}

function flushStreamFrames(state: SparkTtsStreamParserState): SparkTtsStreamFrame[] {
  const frames: SparkTtsStreamFrame[] = [];
  const tail = state.pending.trim();
  if (state.sseData.length > 0) {
    const data = [...state.sseData, ...(tail ? [tail] : [])].join("\n");
    frames.push({ event: state.sseEvent, data });
  } else if (tail) {
    frames.push({ data: tail });
  }
  state.pending = "";
  state.sseData = [];
  state.sseEvent = undefined;
  return frames;
}

function parseStreamFrame(frame: SparkTtsStreamFrame): ParsedSparkTtsStreamEvent | null {
  const raw = frame.data.trim();
  if (!raw) {
    return null;
  }
  if (raw === "[DONE]") {
    return { kind: "end" };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  const eventName =
    (typeof frame.event === "string" ? frame.event.trim().toLowerCase() : "") ||
    (typeof parsed?.event === "string" ? parsed.event.trim().toLowerCase() : "") ||
    (typeof parsed?.type === "string" ? parsed.type.trim().toLowerCase() : "") ||
    (typeof parsed?.state === "string" ? parsed.state.trim().toLowerCase() : "");

  const errorMessage =
    (typeof parsed?.error === "string" && parsed.error.trim()) ||
    (typeof parsed?.message === "string" && parsed.message.trim()) ||
    "";
  if (eventName === "error" || eventName === "failed" || errorMessage) {
    return {
      kind: "error",
      message: errorMessage || "Spark TTS stream emitted an error",
    };
  }

  const done =
    parsed?.done === true ||
    parsed?.final === true ||
    parsed?.complete === true ||
    eventName === "end" ||
    eventName === "done" ||
    eventName === "complete" ||
    eventName === "final";
  if (done) {
    return { kind: "end" };
  }

  const audioBase64 =
    (typeof parsed?.audio_base64 === "string" && parsed.audio_base64.trim()) ||
    (typeof parsed?.audioBase64 === "string" && parsed.audioBase64.trim()) ||
    (typeof parsed?.audio === "string" && parsed.audio.trim()) ||
    (typeof parsed?.chunk === "string" && parsed.chunk.trim()) ||
    "";
  if (!audioBase64) {
    return null;
  }

  const sampleRate =
    typeof parsed?.sample_rate === "number" && Number.isFinite(parsed.sample_rate)
      ? Math.max(1, Math.trunc(parsed.sample_rate))
      : typeof parsed?.sampleRate === "number" && Number.isFinite(parsed.sampleRate)
        ? Math.max(1, Math.trunc(parsed.sampleRate))
        : undefined;

  return {
    kind: "chunk",
    audioBase64,
    format:
      (typeof parsed?.format === "string" && parsed.format.trim()) ||
      (typeof parsed?.mime === "string" && parsed.mime.trim()) ||
      undefined,
    sampleRate,
  };
}

function matchesActiveStream(
  control: SparkTtsStreamControl,
  params: Record<string, unknown>,
  streamId: string | undefined,
): boolean {
  if (streamId && control.streamId === streamId) {
    return true;
  }
  const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
  if (turnId && control.turnId === turnId) {
    return true;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (sessionKey && control.sessionKey === sessionKey) {
    return true;
  }
  const conversationId =
    typeof params.conversationId === "string" ? params.conversationId.trim() : "";
  if (conversationId && control.conversationId === conversationId) {
    return true;
  }
  return false;
}

function emitSparkVoiceStreamEvent(params: {
  context: {
    broadcastToConnIds: (
      event: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => void;
  };
  connId: string;
  event:
    | "spark.voice.stream.started"
    | "spark.voice.stream.chunk"
    | "spark.voice.stream.completed"
    | "spark.voice.stream.error";
  payload: Record<string, unknown>;
}) {
  params.context.broadcastToConnIds(params.event, params.payload, new Set([params.connId]), {
    dropIfSlow: false,
  });
}

function sttBases(
  config: OpenClawConfig,
): Array<{ url: string; headers?: Record<string, string> }> {
  const host = process.env.DGX_HOST?.trim() || "";
  const sttPort = process.env.DGX_STT_PORT?.trim() || "9001";
  const { wanBaseUrl, wanHeaders } = readDgxConfig(config);
  const out: Array<{ url: string; headers?: Record<string, string> }> = [];
  if (host) {
    out.push({ url: `http://${host}:${sttPort}` });
  }
  if (wanBaseUrl) {
    out.push({
      url: wanBaseUrl,
      headers: Object.keys(wanHeaders).length ? wanHeaders : undefined,
    });
  }
  return out;
}

async function tryVoiceJson(
  bases: Array<{ url: string; headers?: Record<string, string> }>,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  let lastErr: string | null = null;
  for (const { url, headers } of bases) {
    const target = `${url.replace(/\/$/, "")}${path}`;
    try {
      const mergedHeaders: Record<string, string> = {
        ...headers,
        ...(init.headers as Record<string, string> | undefined),
      };
      if (init.method === "POST" || init.method === "PUT") {
        mergedHeaders["content-type"] = mergedHeaders["content-type"] ?? "application/json";
      }
      const res = await fetchWithTimeout(target, {
        ...init,
        headers: Object.keys(mergedHeaders).length ? mergedHeaders : undefined,
        timeoutMs,
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr ?? "no voice endpoint reachable");
}

async function startSparkTtsStream(params: {
  context: {
    broadcastToConnIds: (
      event: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => void;
  };
  control: SparkTtsStreamControl;
  text: string;
  format: string;
  voice?: string;
  instruct?: string;
  language?: string;
  clientMessageId?: string;
  source?: string;
}): Promise<void> {
  const cfg = loadConfig();
  const bases = ttsBases(cfg);
  const streamPath = resolveSparkTtsStreamPath();
  const _timeoutMs = resolveSparkTtsTimeoutMs();
  const requestBody: Record<string, unknown> = {
    text: params.text,
    format: params.format,
  };
  if (params.voice) {
    requestBody.voice = params.voice;
  }
  if (params.instruct) {
    requestBody.instruct = params.instruct;
  }
  if (params.language) {
    requestBody.language = params.language;
  }
  if (params.control.sessionKey) {
    requestBody.sessionKey = params.control.sessionKey;
  }
  if (params.control.conversationId) {
    requestBody.conversationId = params.control.conversationId;
  }
  if (params.control.turnId) {
    requestBody.turnId = params.control.turnId;
  }
  if (params.clientMessageId) {
    requestBody.clientMessageId = params.clientMessageId;
  }
  if (params.source) {
    requestBody.source = params.source;
  }

  emitSparkVoiceStreamEvent({
    context: params.context,
    connId: params.control.connId,
    event: "spark.voice.stream.started",
    payload: {
      streamId: params.control.streamId,
      sessionKey: params.control.sessionKey,
      conversationId: params.control.conversationId,
      turnId: params.control.turnId,
      clientMessageId: params.clientMessageId,
      source: params.source,
      format: params.format,
      ts: Date.now(),
    },
  });

  let lastError: string | null = null;
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    lastError = "fetch is not available";
  } else {
    for (const { url, headers } of bases) {
      if (params.control.controller.signal.aborted) {
        return;
      }
      const target = `${url.replace(/\/$/, "")}${streamPath}`;
      try {
        const response = await fetchFn(target, {
          method: "POST",
          headers: {
            accept: "text/event-stream, application/x-ndjson, application/json",
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(requestBody),
          signal: params.control.controller.signal,
        });
        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        if (!response.body) {
          lastError = "Spark TTS stream response missing body";
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createParserState();
        let seq = 0;
        let completed = false;

        const handleFrame = (frame: SparkTtsStreamFrame) => {
          const parsed = parseStreamFrame(frame);
          if (!parsed) {
            return false;
          }
          if (parsed.kind === "error") {
            throw new Error(parsed.message);
          }
          if (parsed.kind === "end") {
            completed = true;
            emitSparkVoiceStreamEvent({
              context: params.context,
              connId: params.control.connId,
              event: "spark.voice.stream.completed",
              payload: {
                streamId: params.control.streamId,
                sessionKey: params.control.sessionKey,
                conversationId: params.control.conversationId,
                turnId: params.control.turnId,
                clientMessageId: params.clientMessageId,
                source: params.source,
                totalChunks: seq,
                durationMs: Date.now() - params.control.startedAtMs,
                ts: Date.now(),
              },
            });
            return true;
          }

          seq += 1;
          emitSparkVoiceStreamEvent({
            context: params.context,
            connId: params.control.connId,
            event: "spark.voice.stream.chunk",
            payload: {
              streamId: params.control.streamId,
              sessionKey: params.control.sessionKey,
              conversationId: params.control.conversationId,
              turnId: params.control.turnId,
              clientMessageId: params.clientMessageId,
              source: params.source,
              seq,
              audioBase64: parsed.audioBase64,
              format: parsed.format ?? params.format,
              sampleRate: parsed.sampleRate,
              ts: Date.now(),
            },
          });
          return false;
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          const text = decoder.decode(value, { stream: true });
          for (const frame of drainStreamFrames(parser, text)) {
            if (handleFrame(frame)) {
              return;
            }
          }
        }

        const tail = decoder.decode();
        const trailingFrames = tail ? drainStreamFrames(parser, tail) : [];
        const finalFrames = [...trailingFrames, ...flushStreamFrames(parser)];
        for (const frame of finalFrames) {
          if (handleFrame(frame)) {
            return;
          }
        }

        if (!completed) {
          emitSparkVoiceStreamEvent({
            context: params.context,
            connId: params.control.connId,
            event: "spark.voice.stream.completed",
            payload: {
              streamId: params.control.streamId,
              sessionKey: params.control.sessionKey,
              conversationId: params.control.conversationId,
              turnId: params.control.turnId,
              clientMessageId: params.clientMessageId,
              source: params.source,
              totalChunks: seq,
              durationMs: Date.now() - params.control.startedAtMs,
              ts: Date.now(),
            },
          });
        }
        return;
      } catch (err) {
        if (params.control.controller.signal.aborted) {
          return;
        }
        lastError = formatForLog(err);
      }
    }
  }

  emitSparkVoiceStreamEvent({
    context: params.context,
    connId: params.control.connId,
    event: "spark.voice.stream.error",
    payload: {
      streamId: params.control.streamId,
      sessionKey: params.control.sessionKey,
      conversationId: params.control.conversationId,
      turnId: params.control.turnId,
      clientMessageId: params.clientMessageId,
      source: params.source,
      message: lastError ?? "Spark TTS stream unavailable",
      ts: Date.now(),
    },
  });
}

export const sparkVoiceMethodsHandlers: GatewayRequestHandlers = {
  "spark.voice.stt": async ({ params, respond }) => {
    const audio =
      typeof params.audio_base64 === "string"
        ? params.audio_base64.trim()
        : typeof params.audio === "string"
          ? params.audio.trim()
          : "";
    if (!audio) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spark.voice.stt requires audio_base64 (or audio)"),
      );
      return;
    }
    const cfg = loadConfig();
    const bases = sttBases(cfg);
    if (bases.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Spark STT unavailable: set DGX_HOST or config.dgx.wanBaseUrl",
        ),
      );
      return;
    }
    const format = typeof params.format === "string" ? params.format.trim() : "webm";
    const sampleRate =
      typeof params.sample_rate === "number"
        ? params.sample_rate
        : typeof params.sampleRate === "number"
          ? params.sampleRate
          : 16_000;
    const language = typeof params.language === "string" ? params.language.trim() : "en";
    const body: Record<string, unknown> = {
      audio_base64: audio,
      format,
      sample_rate: sampleRate,
      language,
    };
    for (const k of [
      "requestId",
      "sessionKey",
      "conversationId",
      "turnId",
      "clientMessageId",
      "source",
    ] as const) {
      const v = params[k];
      if (typeof v === "string" && v.trim()) {
        body[k] = v.trim();
      }
    }
    try {
      const data = await tryVoiceJson(
        bases,
        "/v1/transcribe",
        { method: "POST", body: JSON.stringify(body) },
        120_000,
      );
      respond(true, data, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "spark.voice.tts.cancel": async ({ params, respond }) => {
    const cfg = loadConfig();
    const bases = ttsBases(cfg);
    const cancelBody: Record<string, unknown> = {};
    for (const k of ["streamId", "turnId", "sessionKey", "conversationId"] as const) {
      const v = params[k];
      if (typeof v === "string" && v.trim()) {
        cancelBody[k] = v.trim();
      }
    }
    const bodyJson = JSON.stringify(cancelBody);
    const streamId = typeof cancelBody.streamId === "string" ? cancelBody.streamId : undefined;
    const cancelledStreamIds: string[] = [];
    for (const [activeId, control] of activeSparkTtsStreams) {
      if (!matchesActiveStream(control, params, streamId)) {
        continue;
      }
      cancelledStreamIds.push(activeId);
      control.controller.abort();
      activeSparkTtsStreams.delete(activeId);
    }
    let remoteCancelAttempted = false;
    let remoteCancelOk: boolean | null = null;
    if (bases.length > 0) {
      for (const path of ["/v1/synthesize/cancel", "/v1/tts/cancel"]) {
        let succeeded = false;
        for (const { url, headers } of bases) {
          const target = `${url.replace(/\/$/, "")}${path}`;
          try {
            remoteCancelAttempted = true;
            const mergedHeaders: Record<string, string> = {
              "content-type": "application/json",
              ...headers,
            };
            const res = await fetchWithTimeout(target, {
              method: "POST",
              headers: mergedHeaders,
              body: bodyJson,
              timeoutMs: 8000,
            });
            if (res.ok) {
              remoteCancelOk = true;
              succeeded = true;
              break;
            }
            remoteCancelOk = false;
          } catch {
            remoteCancelOk = false;
            /* try next */
          }
        }
        if (succeeded) {
          break;
        }
      }
    }
    respond(
      true,
      { ok: true, cancelled: true, cancelledStreamIds, remoteCancelAttempted, remoteCancelOk },
      undefined,
    );
  },

  "spark.voice.tts": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spark.voice.tts requires text"),
      );
      return;
    }
    const cfg = loadConfig();
    const bases = ttsBases(cfg);
    if (bases.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Spark TTS unavailable: set DGX_HOST or config.dgx.wanBaseUrl",
        ),
      );
      return;
    }
    const body: Record<string, unknown> = { text };
    for (const k of ["voice", "instruct", "language", "format"] as const) {
      const v = params[k];
      if (typeof v === "string" && v.trim()) {
        body[k] = v.trim();
      }
    }
    try {
      const data = (await tryVoiceJson(
        bases,
        "/v1/synthesize",
        { method: "POST", body: JSON.stringify(body) },
        60_000,
      )) as Record<string, unknown>;
      const audio =
        (typeof data.audio_base64 === "string" && data.audio_base64) ||
        (typeof data.audioBase64 === "string" && data.audioBase64) ||
        "";
      if (!audio) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Spark TTS response missing audio_base64"),
        );
        return;
      }
      const format = typeof data.format === "string" ? data.format : "webm";
      respond(true, { audio_base64: audio, format }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "spark.voice.tts.stream": async ({ params, respond, context, client }) => {
    const connId = typeof client?.connId === "string" ? client.connId.trim() : "";
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "spark.voice.tts.stream requires a websocket client connection",
        ),
      );
      return;
    }

    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spark.voice.tts.stream requires text"),
      );
      return;
    }

    const cfg = loadConfig();
    const bases = ttsBases(cfg);
    if (bases.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Spark TTS unavailable: set DGX_HOST or config.dgx.wanBaseUrl",
        ),
      );
      return;
    }

    const streamId =
      typeof params.streamId === "string" && params.streamId.trim()
        ? params.streamId.trim()
        : randomUUID();
    const control: SparkTtsStreamControl = {
      controller: new AbortController(),
      connId,
      streamId,
      startedAtMs: Date.now(),
      sessionKey:
        typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : undefined,
      conversationId:
        typeof params.conversationId === "string" && params.conversationId.trim()
          ? params.conversationId.trim()
          : undefined,
      turnId:
        typeof params.turnId === "string" && params.turnId.trim()
          ? params.turnId.trim()
          : undefined,
    };
    activeSparkTtsStreams.set(streamId, control);
    void startSparkTtsStream({
      context,
      control,
      text,
      format:
        typeof params.format === "string" && params.format.trim() ? params.format.trim() : "webm",
      voice:
        typeof params.voice === "string" && params.voice.trim() ? params.voice.trim() : undefined,
      instruct:
        typeof params.instruct === "string" && params.instruct.trim()
          ? params.instruct.trim()
          : undefined,
      language:
        typeof params.language === "string" && params.language.trim()
          ? params.language.trim()
          : undefined,
      clientMessageId:
        typeof params.clientMessageId === "string" && params.clientMessageId.trim()
          ? params.clientMessageId.trim()
          : undefined,
      source:
        typeof params.source === "string" && params.source.trim()
          ? params.source.trim()
          : undefined,
    }).finally(() => {
      if (activeSparkTtsStreams.get(streamId) === control) {
        activeSparkTtsStreams.delete(streamId);
      }
    });

    respond(true, { accepted: true, streamId }, undefined);
  },

  "spark.voice.voices": async ({ respond }) => {
    const cfg = loadConfig();
    const bases = ttsBases(cfg);
    if (bases.length === 0) {
      respond(true, { voices: [] }, undefined);
      return;
    }
    try {
      const data = (await tryVoiceJson(bases, "/v1/voices", { method: "GET" }, 12_000)) as Record<
        string,
        unknown
      >;
      const raw = data.voices;
      const voices = Array.isArray(raw) ? raw : [];
      respond(true, { voices }, undefined);
    } catch {
      respond(true, { voices: [] }, undefined);
    }
  },
};
