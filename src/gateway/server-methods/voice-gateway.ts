import fs from "node:fs";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveFetch } from "../../infra/fetch.js";
import {
  getTtsProvider,
  isTtsEnabled,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  textToSpeech,
} from "../../tts/tts.js";
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

function ttsLanBases(
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

function hasSparkEndpoints(cfg: OpenClawConfig): boolean {
  return ttsLanBases(cfg).length > 0;
}

async function transcribeSpark(
  cfg: OpenClawConfig,
  body: Record<string, unknown>,
): Promise<{ text?: string }> {
  const bases = sttBases(cfg);
  let lastErr = "STT unreachable";
  for (const { url, headers } of bases) {
    const target = `${url.replace(/\/$/, "")}/v1/transcribe`;
    try {
      const res = await fetchWithTimeout(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      return (await res.json()) as { text?: string };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

export const voiceGatewayHandlers: GatewayRequestHandlers = {
  "voice.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const dgxHost = hasSparkEndpoints(cfg);
      const enabled = isTtsEnabled(config, prefsPath) || dgxHost;
      const provider = getTtsProvider(config, prefsPath);
      respond(true, {
        enabled,
        mode: dgxHost ? "spark" : "option2a",
        sttProvider: dgxHost ? "spark" : "local",
        ttsProvider: provider ?? (dgxHost ? "spark" : "unknown"),
        capabilities: {
          whisperAvailable: false,
          ffmpegAvailable: false,
          sagAvailable: dgxHost,
          sagAuthenticated: false,
          macosSayAvailable: false,
          personaplexAvailable: false,
          personaplexInstalled: false,
          personaplexRunning: false,
          personaplexDeps: { opus: false, moshi: false, accelerate: false },
        },
        streaming: false,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "voice.transcribe": async ({ params, respond }) => {
    const audio = typeof params.audio === "string" ? params.audio.trim() : "";
    if (!audio) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.transcribe requires audio (base64)"),
      );
      return;
    }
    const format = typeof params.format === "string" ? params.format.trim() : "webm";
    const language = typeof params.language === "string" ? params.language.trim() : "en";
    const sampleRate =
      typeof params.sample_rate === "number"
        ? params.sample_rate
        : typeof params.sampleRate === "number"
          ? params.sampleRate
          : 16_000;
    try {
      const cfg = loadConfig();
      const result = await transcribeSpark(cfg, {
        audio_base64: audio,
        format,
        language,
        sample_rate: sampleRate,
      });
      const text = typeof result.text === "string" ? result.text : "";
      respond(true, { text }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "voice.synthesize": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.synthesize requires text"),
      );
      return;
    }
    const cfg = loadConfig();
    if (hasSparkEndpoints(cfg)) {
      try {
        const ttsBases = ttsLanBases(cfg);
        let lastErr = "TTS failed";
        for (const { url: base, headers } of ttsBases) {
          const url = `${base.replace(/\/$/, "")}/v1/synthesize`;
          try {
            const res = await fetchWithTimeout(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...headers,
              },
              body: JSON.stringify({ text }),
              timeoutMs: 120_000,
            });
            if (!res.ok) {
              lastErr = `HTTP ${res.status}`;
              continue;
            }
            const data = (await res.json()) as Record<string, unknown>;
            const b64 =
              (typeof data.audio_base64 === "string" && data.audio_base64) ||
              (typeof data.audioBase64 === "string" && data.audioBase64) ||
              "";
            if (b64) {
              respond(
                true,
                { audioBase64: b64, provider: "spark", latencyMs: undefined },
                undefined,
              );
              return;
            }
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
          }
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, lastErr));
        return;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
        return;
      }
    }

    try {
      const t0 = Date.now();
      const result = await textToSpeech({ text, cfg });
      if (!result.success || !result.audioPath) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "TTS synthesis failed"));
        return;
      }
      const buf = fs.readFileSync(result.audioPath);
      const audioBase64 = buf.toString("base64");
      respond(
        true,
        {
          audioBase64,
          audioPath: result.audioPath,
          provider: result.provider,
          latencyMs: result.latencyMs ?? Date.now() - t0,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
