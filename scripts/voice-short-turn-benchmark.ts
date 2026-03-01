import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown } | string | null;
};
type GatewayEventFrame = { type: "event"; event: string; seq?: number; payload?: unknown };
type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame | { type: string };

type PendingRequest = {
  resolve: (frame: GatewayResFrame) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingSparkTtsStream = {
  startedAtMs: number;
  firstChunkAtMs: number | null;
  resolve: (result: {
    firstByteMs: number;
    fullCompletionMs: number;
    reportedDurationMs: number | null;
    totalChunks: number | null;
  }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BenchmarkRow = {
  turn: number;
  turnId: string;
  sttTotalMs: number | null;
  llmFirstSemanticTextMs: number | null;
  llmFullCompletionMs: number | null;
  ttsFirstByteMs: number | null;
  ttsFullCompletionMs: number | null;
  ttsReportedDurationMs: number | null;
  eosToFirstSemanticTextMs: number | null;
  eosToFirstAudibleByteMs: number | null;
  transcriptionChars: number;
  responseChars: number;
  responseEmpty: boolean;
  route: string | null;
  model: string | null;
  thinkingLevel: string | null;
  ttsModeUsed: "stream" | "non-stream" | null;
  streamChunks: number | null;
  transcriptionWasEmpty: boolean;
  status: "ok" | "error";
  errorMessage: string | null;
};

const DEFAULT_RUNS = 30;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_SPOKEN_OUTPUT_MODE = "concise";
const DEFAULT_OUT_CSV = "benchmarks/voice_short_turn_benchmark.csv";
const DEFAULT_TEXT_FALLBACK = "hello";
const DEFAULT_TTS_MODE = "auto";
const DEFAULT_CLIENT_ID = "test";
const DEFAULT_CLIENT_MODE = "test";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

if (hasFlag("--help") || hasFlag("-h")) {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  pnpm benchmark:voice:short-turn -- --runs 30 --audio /abs/path/sample.wav [options]

Options:
  --url <ws://host:port>              Gateway URL (default: OPENCLAW_GATEWAY_URL or ws://127.0.0.1:32555)
  --token <token>                     Gateway token (or OPENCLAW_GATEWAY_TOKEN)
  --password <password>               Gateway password (or OPENCLAW_GATEWAY_PASSWORD)
  --runs <n>                          Number of turns (default: 30)
  --timeout-ms <ms>                   Per-request timeout (default: 120000)
  --session-key <key>                 Session key (default: agent:main:main)
  --audio <path>                      Audio sample path (.wav/.webm)
  --audio-base64 <b64>                Audio sample as base64
  --format <wav|webm>                 STT format override
  --voice <name>                      Optional TTS voice
  --instruct <text>                   Optional TTS instruct/style
  --language <lang>                   Optional TTS language
  --spoken-output-mode <concise|full|status>
  --latency-profile <default|short_turn_fast> voice.processText profile (default: default)
  --allow-tools <true|false>          voice.processText allowTools flag (default: true)
  --max-output-tokens <n>             voice.processText maxOutputTokens hint
  --tts-mode <auto|stream|non-stream> TTS mode (default: auto)
  --text-fallback <text>              Fallback text when STT is empty (default: "hello")
  --silence-sec <n>                   Generated WAV silence duration when no audio provided (default: 4)
  --no-drive-openclaw                 Disable driveOpenClaw on voice.processText
  --out-csv <path>                    Output CSV path (default: benchmarks/voice_short_turn_benchmark.csv)
  --fail-fast                         Stop on first turn error
`);
  process.exit(0);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseWsUrl(raw: string | undefined): string {
  const candidate =
    raw?.trim() || process.env.OPENCLAW_GATEWAY_URL?.trim() || "ws://127.0.0.1:32555";
  if (candidate.includes("://")) {
    return candidate;
  }
  return `ws://${candidate}`;
}

function resolveFormat(raw: string | undefined, audioPath: string | undefined): "wav" | "webm" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "wav" || normalized === "webm") {
    return normalized;
  }
  const ext = audioPath ? path.extname(audioPath).toLowerCase() : "";
  if (ext === ".wav") {
    return "wav";
  }
  if (ext === ".webm") {
    return "webm";
  }
  return "wav";
}

function resolveTtsMode(raw: string | undefined): "auto" | "stream" | "non-stream" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "stream" || normalized === "non-stream" || normalized === "auto") {
    return normalized;
  }
  return DEFAULT_TTS_MODE;
}

function resolveLatencyProfile(raw: string | undefined): "default" | "short_turn_fast" {
  return raw?.trim().toLowerCase() === "short_turn_fast" ? "short_turn_fast" : "default";
}

function parseMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

function resolveTimingMs(record: unknown, keys: string[]): number | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const rec = record as Record<string, unknown>;
  for (const key of keys) {
    const value = parseMs(rec[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const clamped = Math.max(0, Math.min(100, p));
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((clamped / 100) * sorted.length) - 1),
  );
  return Number(sorted[index]!.toFixed(1));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toCsvCell(value: string | number | boolean | null): string {
  if (value == null) {
    return "";
  }
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function encodeSilenceWav(params: {
  durationSec: number;
  sampleRate?: number;
  channels?: number;
}): string {
  const sampleRate = params.sampleRate ?? 16_000;
  const channels = params.channels ?? 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.floor(params.durationSec * sampleRate));
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = 44 + dataSize;

  const buf = Buffer.alloc(fileSize);
  let offset = 0;
  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(fileSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;
  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset); // PCM
  offset += 2;
  buf.writeUInt16LE(channels, offset);
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(byteRate, offset);
  offset += 4;
  buf.writeUInt16LE(blockAlign, offset);
  offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset);
  offset += 2;
  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(dataSize, offset);
  offset += 4;
  // Remaining bytes are silence (already zero-filled).
  return buf.toString("base64");
}

async function loadAudioBase64(params: {
  audioPath?: string;
  audioBase64?: string;
  format: "wav" | "webm";
  silenceSec: number;
}): Promise<string> {
  if (params.audioBase64 && params.audioBase64.trim()) {
    return params.audioBase64.trim();
  }
  if (params.audioPath) {
    const bytes = await fs.readFile(params.audioPath);
    return bytes.toString("base64");
  }
  if (params.format === "wav") {
    return encodeSilenceWav({ durationSec: params.silenceSec });
  }
  throw new Error("Missing --audio/--audio-base64 for webm format benchmark.");
}

function toText(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data as Buffer).toString("utf8");
}

async function main(): Promise<void> {
  const url = parseWsUrl(getArg("--url"));
  const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const password = getArg("--password") ?? process.env.OPENCLAW_GATEWAY_PASSWORD;
  const runs = parsePositiveInt(getArg("--runs"), DEFAULT_RUNS);
  const timeoutMs = parsePositiveInt(getArg("--timeout-ms"), DEFAULT_TIMEOUT_MS);
  const sessionKey = getArg("--session-key") ?? DEFAULT_SESSION_KEY;
  const outCsv = path.resolve(getArg("--out-csv") ?? DEFAULT_OUT_CSV);
  const audioPath = getArg("--audio");
  const format = resolveFormat(getArg("--format"), audioPath);
  const textFallback = getArg("--text-fallback") ?? DEFAULT_TEXT_FALLBACK;
  const voice = getArg("--voice");
  const instruct = getArg("--instruct");
  const language = getArg("--language");
  const spokenOutputMode = getArg("--spoken-output-mode") ?? DEFAULT_SPOKEN_OUTPUT_MODE;
  const latencyProfile = resolveLatencyProfile(getArg("--latency-profile"));
  const allowToolsRaw = getArg("--allow-tools");
  const allowTools = allowToolsRaw ? allowToolsRaw.trim().toLowerCase() !== "false" : true;
  const maxOutputTokensArg = getArg("--max-output-tokens");
  const maxOutputTokens = maxOutputTokensArg
    ? parsePositiveInt(maxOutputTokensArg, 120)
    : undefined;
  const ttsMode = resolveTtsMode(getArg("--tts-mode"));
  const driveOpenClaw = !hasFlag("--no-drive-openclaw");
  const source = "voice";
  const silenceSec = Number(getArg("--silence-sec") ?? "4") || 4;
  const auth =
    token || password
      ? {
          token: token ?? undefined,
          password: password ?? undefined,
        }
      : undefined;

  const audioBase64 = await loadAudioBase64({
    audioPath,
    audioBase64: getArg("--audio-base64"),
    format,
    silenceSec,
  });

  const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
  const pending = new Map<string, PendingRequest>();
  const pendingStreams = new Map<string, PendingSparkTtsStream>();
  let sparkTtsStreamSupported = ttsMode !== "non-stream";

  const failAllPending = (reason: string): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
    }
    for (const [streamId, waiter] of pendingStreams) {
      pendingStreams.delete(streamId);
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
    }
  };

  const request = (method: string, params?: unknown): Promise<GatewayResFrame> =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("gateway websocket is not open"));
        return;
      }
      const id = randomUUID();
      const frame: GatewayReqFrame = { type: "req", id, method, params };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });

  const waitForSparkTtsStream = (
    streamId: string,
    startedAtMs: number,
  ): Promise<{
    firstByteMs: number;
    fullCompletionMs: number;
    reportedDurationMs: number | null;
    totalChunks: number | null;
  }> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingStreams.delete(streamId);
        reject(new Error("SPARK_TTS_STREAM_TIMEOUT"));
      }, timeoutMs);
      pendingStreams.set(streamId, {
        startedAtMs,
        firstChunkAtMs: null,
        resolve,
        reject,
        timeout,
      });
    });

  const moveSparkStreamWaiter = (fromStreamId: string, toStreamId: string): void => {
    if (fromStreamId === toStreamId) {
      return;
    }
    const pendingStream = pendingStreams.get(fromStreamId);
    if (!pendingStream) {
      return;
    }
    pendingStreams.delete(fromStreamId);
    pendingStreams.set(toStreamId, pendingStream);
  };

  const rejectSparkStreamWaiter = (streamId: string, reason: string): void => {
    const pendingStream = pendingStreams.get(streamId);
    if (!pendingStream) {
      return;
    }
    pendingStreams.delete(streamId);
    clearTimeout(pendingStream.timeout);
    pendingStream.reject(new Error(reason));
  };

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  ws.on("close", () => {
    failAllPending("gateway websocket closed");
  });
  ws.on("error", (err) => {
    failAllPending(err instanceof Error ? err.message : "gateway websocket error");
  });

  ws.on("message", (data) => {
    let parsed: GatewayFrame | null = null;
    try {
      parsed = JSON.parse(toText(data)) as GatewayFrame;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return;
    }
    if (parsed.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        return;
      }
      if (
        evt.event === "spark.voice.stream.chunk" ||
        evt.event === "spark.voice.stream.completed" ||
        evt.event === "spark.voice.stream.error"
      ) {
        const payload =
          evt.payload && typeof evt.payload === "object"
            ? (evt.payload as Record<string, unknown>)
            : null;
        const streamId =
          payload && typeof payload.streamId === "string" && payload.streamId.trim()
            ? payload.streamId.trim()
            : null;
        if (!streamId) {
          return;
        }
        const pendingStream = pendingStreams.get(streamId);
        if (!pendingStream) {
          return;
        }
        if (evt.event === "spark.voice.stream.chunk") {
          if (pendingStream.firstChunkAtMs == null) {
            pendingStream.firstChunkAtMs = Date.now();
          }
          return;
        }
        pendingStreams.delete(streamId);
        clearTimeout(pendingStream.timeout);
        if (evt.event === "spark.voice.stream.error") {
          const message =
            payload && typeof payload.message === "string" && payload.message.trim()
              ? payload.message.trim()
              : "SPARK_TTS_STREAM_FAILED";
          const code =
            payload && typeof payload.code === "string" && payload.code.trim()
              ? payload.code.trim()
              : "";
          pendingStream.reject(new Error(code ? `${code}: ${message}` : message));
          return;
        }
        const completedAtMs = Date.now();
        const localCompletionMs = Math.max(0, completedAtMs - pendingStream.startedAtMs);
        const firstByteMs =
          pendingStream.firstChunkAtMs != null
            ? Math.max(0, pendingStream.firstChunkAtMs - pendingStream.startedAtMs)
            : null;
        const durationMsRaw = payload?.durationMs;
        const reportedDurationMs =
          typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
            ? Math.max(0, durationMsRaw)
            : null;
        const totalChunksRaw = payload?.totalChunks;
        const totalChunks =
          typeof totalChunksRaw === "number" && Number.isFinite(totalChunksRaw)
            ? Math.max(0, Math.trunc(totalChunksRaw))
            : null;
        pendingStream.resolve({
          firstByteMs: firstByteMs ?? localCompletionMs,
          fullCompletionMs: localCompletionMs,
          reportedDurationMs,
          totalChunks,
        });
        return;
      }
      return;
    }
    if (parsed.type === "res") {
      const res = parsed as GatewayResFrame;
      const waiter = pending.get(res.id);
      if (!waiter) {
        return;
      }
      pending.delete(res.id);
      clearTimeout(waiter.timeout);
      waiter.resolve(res);
    }
  });

  await waitOpen();

  const connectRes = await request("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: DEFAULT_CLIENT_ID,
      displayName: "voice short-turn benchmark",
      version: "dev",
      platform: process.platform,
      mode: DEFAULT_CLIENT_MODE,
      instanceId: "voice-short-turn-benchmark",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: ["tool-events"],
    auth,
  });
  if (!connectRes.ok) {
    const message =
      (connectRes.error as { message?: string } | undefined)?.message ?? "connect failed";
    throw new Error(`gateway connect failed: ${message}`);
  }

  const conversationId = `bench-conv-${randomUUID().slice(0, 8)}`;
  const rows: BenchmarkRow[] = [];

  for (let index = 0; index < runs; index += 1) {
    const turn = index + 1;
    const turnId = `bench-turn-${turn}-${randomUUID().slice(0, 8)}`;
    const clientMessageId = `bench-msg-${turn}-${randomUUID().slice(0, 8)}`;

    const row: BenchmarkRow = {
      turn,
      turnId,
      sttTotalMs: null,
      llmFirstSemanticTextMs: null,
      llmFullCompletionMs: null,
      ttsFirstByteMs: null,
      ttsFullCompletionMs: null,
      ttsReportedDurationMs: null,
      eosToFirstSemanticTextMs: null,
      eosToFirstAudibleByteMs: null,
      transcriptionChars: 0,
      responseChars: 0,
      responseEmpty: false,
      route: null,
      model: null,
      thinkingLevel: null,
      ttsModeUsed: null,
      streamChunks: null,
      transcriptionWasEmpty: false,
      status: "ok",
      errorMessage: null,
    };

    try {
      const sttRequestId = `${turnId}-stt`;
      const sttStart = Date.now();
      const sttRes = await request("spark.voice.stt", {
        audio_base64: audioBase64,
        format,
        requestId: sttRequestId,
        sessionKey,
        conversationId,
        turnId,
        clientMessageId,
        source,
      });
      const sttWallMs = Date.now() - sttStart;
      if (!sttRes.ok) {
        const message =
          (sttRes.error as { message?: string } | undefined)?.message ?? "spark.voice.stt failed";
        throw new Error(message);
      }
      const sttPayload = (sttRes.payload ?? {}) as Record<string, unknown>;
      const sttTimings = (sttPayload.timings_ms ?? {}) as Record<string, unknown>;
      const sttTotalMs =
        resolveTimingMs(sttTimings, ["gateway_total_ms", "total_ms", "dgx_total_ms"]) ?? sttWallMs;
      row.sttTotalMs = Number(sttTotalMs.toFixed(1));

      const transcriptRaw = asText(sttPayload.text).trim();
      const transcription = transcriptRaw || textFallback;
      row.transcriptionChars = transcriptRaw.length;
      row.transcriptionWasEmpty = transcriptRaw.length === 0;

      const llmRequestId = `${turnId}-llm`;
      const llmStart = Date.now();
      const llmRes = await request("voice.processText", {
        text: transcription,
        requestId: llmRequestId,
        sessionKey,
        driveOpenClaw,
        skipTts: true,
        conversationId,
        turnId,
        clientMessageId,
        source,
        spokenOutputMode,
        latencyProfile,
        allowTools,
        maxOutputTokens,
      });
      const llmWallMs = Date.now() - llmStart;
      if (!llmRes.ok) {
        const message =
          (llmRes.error as { message?: string } | undefined)?.message ?? "voice.processText failed";
        throw new Error(message);
      }
      const llmPayload = (llmRes.payload ?? {}) as Record<string, unknown>;
      const llmTimings = (llmPayload.timings ?? {}) as Record<string, unknown>;
      const llmFirstSemanticTextMs = resolveTimingMs(llmTimings, [
        "llmFirstSemanticMs",
        "llm_first_semantic_ms",
      ]);
      const llmFullCompletionMs =
        resolveTimingMs(llmTimings, [
          "llmFullCompletionMs",
          "llm_full_completion_ms",
          "llmMs",
          "llm_ms",
        ]) ?? llmWallMs;
      row.llmFirstSemanticTextMs =
        llmFirstSemanticTextMs != null ? Number(llmFirstSemanticTextMs.toFixed(1)) : null;
      row.llmFullCompletionMs = Number(llmFullCompletionMs.toFixed(1));
      row.route = asText(llmPayload.route) || null;
      row.model = asText(llmPayload.model) || null;
      row.thinkingLevel = asText(llmPayload.thinkingLevel) || null;

      const responseText = asText(llmPayload.response);
      const spokenResponse = asText(llmPayload.spokenResponse);
      const ttsText =
        (spokenResponse || responseText).trim() || responseText.trim() || textFallback;
      row.responseChars = responseText.length;
      row.responseEmpty = responseText.trim().length === 0;
      if (row.responseEmpty && spokenOutputMode !== "status") {
        throw new Error("voice.processText returned empty response");
      }

      const ttsRequestId = `${turnId}-tts`;
      const ttsStart = Date.now();
      const ttsParams: Record<string, unknown> = {
        text: ttsText,
        format: "webm",
        requestId: ttsRequestId,
        sessionKey,
        conversationId,
        turnId,
        clientMessageId,
        source,
      };
      if (voice && voice.trim()) {
        ttsParams.voice = voice.trim();
      }
      if (instruct && instruct.trim()) {
        ttsParams.instruct = instruct.trim();
      }
      if (language && language.trim()) {
        ttsParams.language = language.trim();
      }

      let ttsFirstByteMs: number | null = null;
      let ttsFullCompletionMs: number | null = null;
      let ttsReportedDurationMs: number | null = null;
      const shouldTryStream =
        ttsMode === "stream" || (ttsMode === "auto" && sparkTtsStreamSupported);
      if (shouldTryStream) {
        row.ttsModeUsed = "stream";
        const requestedStreamId = `${turnId}-stream`;
        const streamWait = waitForSparkTtsStream(requestedStreamId, ttsStart);
        const streamRes = await request("spark.voice.tts.stream", {
          ...ttsParams,
          streamId: requestedStreamId,
        });
        if (!streamRes.ok) {
          rejectSparkStreamWaiter(requestedStreamId, "SPARK_TTS_STREAM_START_FAILED");
          await streamWait.catch(() => undefined);
          const message =
            (streamRes.error as { message?: string } | undefined)?.message ??
            "spark.voice.tts.stream failed";
          const lowered = message.toLowerCase();
          const unsupported =
            lowered.includes("unknown method") ||
            lowered.includes("spark.voice.tts.stream") ||
            lowered.includes("method not found");
          if (ttsMode === "auto" && unsupported) {
            sparkTtsStreamSupported = false;
          } else {
            throw new Error(message);
          }
        } else {
          const ack = (streamRes.payload ?? {}) as Record<string, unknown>;
          const ackStreamIdRaw = ack.streamId;
          const ackStreamId =
            typeof ackStreamIdRaw === "string" && ackStreamIdRaw.trim()
              ? ackStreamIdRaw.trim()
              : requestedStreamId;
          moveSparkStreamWaiter(requestedStreamId, ackStreamId);
          if (ack.accepted === false) {
            rejectSparkStreamWaiter(ackStreamId, "SPARK_TTS_STREAM_REJECTED");
            await streamWait.catch(() => undefined);
            if (ttsMode === "auto") {
              sparkTtsStreamSupported = false;
            } else {
              throw new Error("SPARK_TTS_STREAM_REJECTED");
            }
          } else {
            const streamMetrics = await streamWait;
            ttsFirstByteMs = streamMetrics.firstByteMs;
            ttsFullCompletionMs = streamMetrics.fullCompletionMs;
            ttsReportedDurationMs = streamMetrics.reportedDurationMs;
            row.streamChunks = streamMetrics.totalChunks;
          }
        }
      }

      if (ttsFirstByteMs == null || ttsFullCompletionMs == null) {
        row.ttsModeUsed = "non-stream";
        const ttsRes = await request("spark.voice.tts", ttsParams);
        const ttsWallMs = Date.now() - ttsStart;
        if (!ttsRes.ok) {
          const message =
            (ttsRes.error as { message?: string } | undefined)?.message ?? "spark.voice.tts failed";
          throw new Error(message);
        }
        const ttsPayload = (ttsRes.payload ?? {}) as Record<string, unknown>;
        const ttsTimings = (ttsPayload.timings_ms ?? {}) as Record<string, unknown>;
        ttsReportedDurationMs = resolveTimingMs(ttsTimings, [
          "total_ms",
          "tts_total_ms",
          "compute_ms",
        ]);
        ttsFullCompletionMs = ttsWallMs;
        ttsFirstByteMs =
          resolveTimingMs(ttsTimings, ["first_byte_ms", "firstByteMs", "tts_first_byte_ms"]) ??
          ttsFullCompletionMs;
      }

      if (ttsFirstByteMs > ttsFullCompletionMs) {
        throw new Error(
          `invalid_tts_metrics:first_byte_gt_full first=${ttsFirstByteMs.toFixed(1)} full=${ttsFullCompletionMs.toFixed(1)}`,
        );
      }

      row.ttsFirstByteMs = Number(ttsFirstByteMs.toFixed(1));
      row.ttsFullCompletionMs = Number(ttsFullCompletionMs.toFixed(1));
      row.ttsReportedDurationMs =
        ttsReportedDurationMs != null ? Number(ttsReportedDurationMs.toFixed(1)) : null;

      const llmSemanticMs = llmFirstSemanticTextMs ?? llmFullCompletionMs;
      row.eosToFirstSemanticTextMs = Number((sttTotalMs + llmSemanticMs).toFixed(1));
      row.eosToFirstAudibleByteMs = Number(
        (sttTotalMs + llmFullCompletionMs + ttsFirstByteMs).toFixed(1),
      );

      // eslint-disable-next-line no-console
      console.log(
        `[turn ${turn}/${runs}] ok route=${row.route ?? "n/a"} model=${row.model ?? "n/a"} ttsMode=${row.ttsModeUsed ?? "n/a"} stt=${row.sttTotalMs}ms llmFirst=${row.llmFirstSemanticTextMs ?? "n/a"}ms llmFull=${row.llmFullCompletionMs}ms ttsFirst=${row.ttsFirstByteMs}ms ttsFull=${row.ttsFullCompletionMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      row.status = "error";
      row.errorMessage = message;
      // eslint-disable-next-line no-console
      console.error(`[turn ${turn}/${runs}] error ${message}`);
      if (hasFlag("--fail-fast")) {
        rows.push(row);
        break;
      }
    }

    rows.push(row);
  }

  ws.close();

  const csvHeader = [
    "turn",
    "turn_id",
    "stt_total_ms",
    "llm_first_semantic_text_ms",
    "llm_full_completion_ms",
    "tts_first_byte_ms",
    "tts_full_completion_ms",
    "tts_reported_duration_ms",
    "eos_to_first_semantic_text_ms",
    "eos_to_first_audible_byte_ms",
    "transcription_chars",
    "response_chars",
    "response_empty",
    "route",
    "model",
    "thinking_level",
    "tts_mode_used",
    "stream_chunks",
    "transcription_was_empty",
    "status",
    "error_message",
  ];
  const csvLines = [
    csvHeader.join(","),
    ...rows.map((row) =>
      [
        row.turn,
        row.turnId,
        row.sttTotalMs,
        row.llmFirstSemanticTextMs,
        row.llmFullCompletionMs,
        row.ttsFirstByteMs,
        row.ttsFullCompletionMs,
        row.ttsReportedDurationMs,
        row.eosToFirstSemanticTextMs,
        row.eosToFirstAudibleByteMs,
        row.transcriptionChars,
        row.responseChars,
        row.responseEmpty,
        row.route,
        row.model,
        row.thinkingLevel,
        row.ttsModeUsed,
        row.streamChunks,
        row.transcriptionWasEmpty,
        row.status,
        row.errorMessage,
      ]
        .map(toCsvCell)
        .join(","),
    ),
  ];
  await fs.mkdir(path.dirname(outCsv), { recursive: true });
  await fs.writeFile(outCsv, `${csvLines.join("\n")}\n`, "utf8");

  const okRows = rows.filter((row) => row.status === "ok");
  const metricValues = (selector: (row: BenchmarkRow) => number | null) =>
    okRows
      .map(selector)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const summary = {
    runsRequested: runs,
    runsCompleted: rows.length,
    runsSucceeded: okRows.length,
    ttsModeRequested: ttsMode,
    ttsStreamDetected: sparkTtsStreamSupported,
    latencyProfile,
    allowTools,
    maxOutputTokens: maxOutputTokens ?? null,
    csvPath: outCsv,
    metrics: {
      stt_total_ms: {
        p50: percentile(
          metricValues((row) => row.sttTotalMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.sttTotalMs),
          95,
        ),
      },
      llm_first_semantic_text_ms: {
        p50: percentile(
          metricValues((row) => row.llmFirstSemanticTextMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.llmFirstSemanticTextMs),
          95,
        ),
      },
      llm_full_completion_ms: {
        p50: percentile(
          metricValues((row) => row.llmFullCompletionMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.llmFullCompletionMs),
          95,
        ),
      },
      tts_first_byte_ms: {
        p50: percentile(
          metricValues((row) => row.ttsFirstByteMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.ttsFirstByteMs),
          95,
        ),
      },
      tts_full_completion_ms: {
        p50: percentile(
          metricValues((row) => row.ttsFullCompletionMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.ttsFullCompletionMs),
          95,
        ),
      },
      tts_reported_duration_ms: {
        p50: percentile(
          metricValues((row) => row.ttsReportedDurationMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.ttsReportedDurationMs),
          95,
        ),
      },
      eos_to_first_semantic_text_ms: {
        p50: percentile(
          metricValues((row) => row.eosToFirstSemanticTextMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.eosToFirstSemanticTextMs),
          95,
        ),
      },
      eos_to_first_audible_byte_ms: {
        p50: percentile(
          metricValues((row) => row.eosToFirstAudibleByteMs),
          50,
        ),
        p95: percentile(
          metricValues((row) => row.eosToFirstAudibleByteMs),
          95,
        ),
      },
    },
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  if (!okRows.length) {
    throw new Error("No successful benchmark turns. Check gateway credentials/services.");
  }
}

await main();
