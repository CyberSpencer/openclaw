/**
 * Spark voice STT/TTS gateway methods.
 *
 * Standalone from PersonaPlex. Calls DGX-hosted STT and TTS services
 * when Spark is enabled and reachable. Fails cleanly when Spark is down.
 */

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
const MAX_STT_AUDIO_BASE64_CHARS = 20_000_000;
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
   * Response: { text: string; confidence?: number; language_detected?: string }
   */
  "spark.voice.stt": async ({ respond, params }) => {
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

      const audioBase64 = params?.audio_base64;
      if (typeof audioBase64 !== "string" || !audioBase64) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "audio_base64 is required"),
        );
        return;
      }
      if (audioBase64.length > MAX_STT_AUDIO_BASE64_CHARS) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `audio_base64 exceeds max size (${MAX_STT_AUDIO_BASE64_CHARS} chars)`,
          ),
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(urls.sttUrl, {
          method: "POST",
          headers: mergeDgxRequestHeaders(access.context, {
            "content-type": "application/json",
            accept: "application/json",
          }),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Spark STT returned HTTP ${response.status}`),
          );
          return;
        }

        const result = (await response.json()) as Record<string, unknown>;
        respond(true, {
          text: result.text ?? "",
          confidence: result.confidence,
          language_detected: result.language_detected,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, `Spark TTS returned HTTP ${response.status}`),
          );
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
