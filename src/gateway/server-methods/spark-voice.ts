/**
 * Spark voice STT/TTS gateway methods.
 *
 * Standalone from PersonaPlex. Calls DGX-hosted STT and TTS services
 * when Spark is enabled and reachable. Fails cleanly when Spark is down.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TTS_TIMEOUT_MS = 60_000;
const MIN_TTS_TIMEOUT_MS = 30_000;
const MAX_STT_AUDIO_BASE64_CHARS = 2_600_000;
const MAX_TTS_TEXT_CHARS = 12_000;

// ---------------------------------------------------------------------------
// Env resolution (same pattern as spark-status.ts)
// ---------------------------------------------------------------------------

function parseBooleanLike(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseStringLike(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  return unquoted.trim() || undefined;
}

function resolveContractPath(): string | null {
  const explicit = process.env.OPENCLAW_CONTRACT?.trim();
  if (explicit) {
    return explicit;
  }
  const fallback = path.resolve(process.cwd(), "config", "workspace.env");
  return existsSync(fallback) ? fallback : null;
}

function readContractEnv(contractPath: string | null): Record<string, string> {
  if (!contractPath || !existsSync(contractPath)) {
    return {};
  }
  try {
    const result: Record<string, string> = {};
    const lines = readFileSync(contractPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const idx = trimmed.indexOf("=");
      if (idx < 0) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      if (!key) {
        continue;
      }
      const value = trimmed.slice(idx + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function resolveEffectiveEnv(): Record<string, string> {
  const base = readContractEnv(resolveContractPath());
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return base;
}

function resolveDgxEnabled(env: Record<string, string>): boolean {
  return Boolean(parseBooleanLike(env.DGX_ENABLED) ?? parseBooleanLike(process.env.DGX_ENABLED));
}

function resolveDgxHost(env: Record<string, string>): string | undefined {
  return parseStringLike(env.DGX_HOST) ?? parseStringLike(process.env.DGX_HOST);
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

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

function resolveSttUrl(env: Record<string, string>): string | undefined {
  const host = resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = Number(
    parseStringLike(env.DGX_STT_PORT) ??
      parseStringLike(process.env.DGX_STT_PORT) ??
      DEFAULT_STT_PORT,
  );
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_STT_PORT}/v1/transcribe`;
}

function resolveTtsUrl(env: Record<string, string>): string | undefined {
  const host = resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = Number(
    parseStringLike(env.DGX_TTS_PORT) ??
      parseStringLike(process.env.DGX_TTS_PORT) ??
      DEFAULT_TTS_PORT,
  );
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_TTS_PORT}/v1/synthesize`;
}

function resolveVoicesUrl(env: Record<string, string>): string | undefined {
  const host = resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = Number(
    parseStringLike(env.DGX_TTS_PORT) ??
      parseStringLike(process.env.DGX_TTS_PORT) ??
      DEFAULT_TTS_PORT,
  );
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_TTS_PORT}/v1/voices`;
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

      const url = resolveSttUrl(env);
      if (!url) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "DGX_HOST not configured"));
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

      const formatLog = body.format ?? "webm";
      const sampleRateLog = body.sample_rate ?? 16_000;
      console.warn(
        `[spark-voice] STT request: format=${formatLog} sample_rate=${sampleRateLog} audio_base64_len=${audioBase64.length}`,
      );

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          console.warn(`[spark-voice] STT HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
          let detail = "";
          try {
            const parsed = JSON.parse(bodyText) as Record<string, unknown>;
            detail = typeof parsed?.detail === "string" ? parsed.detail : "";
          } catch {
            /* not JSON */
          }
          const msg = detail
            ? `Spark STT (${response.status}): ${detail}`
            : `Spark STT returned HTTP ${response.status}`;
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
          return;
        }

        const result = (await response.json()) as Record<string, unknown>;
        const text = result.text ?? "";
        console.warn(
          `[spark-voice] STT success: text_len=${typeof text === "string" ? text.length : 0}`,
        );
        respond(true, {
          text,
          confidence: result.confidence,
          language_detected: result.language_detected,
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

      const url = resolveTtsUrl(env);
      if (!url) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "DGX_HOST not configured"));
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
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
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
      const ttsUrl = resolveTtsUrl(env);
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
      const url = resolveVoicesUrl(env);
      if (!url) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "DGX_HOST not configured"));
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
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
