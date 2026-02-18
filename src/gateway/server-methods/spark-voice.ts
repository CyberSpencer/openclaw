/**
 * Spark voice STT/TTS gateway methods.
 *
 * Standalone from PersonaPlex. Calls DGX-hosted STT and TTS services
 * when Spark is enabled and reachable. Fails cleanly when Spark is down.
 */

import { randomUUID } from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
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

const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const MIN_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_STT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TTS_TEXT_CHARS = 12_000;

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

function resolveSparkVoiceUrls(
  env: Record<string, string>,
  context: DgxAccessContext,
): { sttUrl: string; ttsUrl: string; voicesUrl: string } | undefined {
  if (context.mode === "wan") {
    const sttBase = resolveWanServiceBaseUrl(context, "voiceStt");
    const ttsBase = resolveWanServiceBaseUrl(context, "voiceTts");
    if (!sttBase || !ttsBase) {
      return undefined;
    }
    return {
      sttUrl: appendUrlPath(sttBase, "v1/transcribe"),
      ttsUrl: appendUrlPath(ttsBase, "v1/synthesize"),
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
  const fromHeader = asTrimmedString(response.headers.get("x-request-id") ?? undefined);
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

      const requestId = randomUUID();
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
          headers: mergeDgxRequestHeaders(access.context, {
            "content-type": "application/json",
            accept: "application/json",
            "x-request-id": requestId,
          }),
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
      };

      const ttsTimeoutMs = resolveTtsTimeoutMs(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ttsTimeoutMs);

      try {
        const response = await fetch(urls.ttsUrl, {
          method: "POST",
          headers: mergeDgxRequestHeaders(access.context, {
            "content-type": "application/json",
            accept: "application/json",
          }),
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
        respond(true, {
          audio_base64: result.audio_base64 ?? "",
          format: result.format,
          sample_rate: result.sample_rate,
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
