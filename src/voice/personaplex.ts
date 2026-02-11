/**
 * PersonaPlex S2S (Speech-to-Speech) integration.
 *
 * NVIDIA PersonaPlex-7B-v1 provides end-to-end speech processing
 * without intermediate text conversion.
 *
 * This module is EXPERIMENTAL and requires:
 * - GPU with MPS support (Apple Silicon) or CUDA
 * - ~16GB memory
 * - HuggingFace token with model access
 *
 * Feature flag: config.voice.personaplex.enabled
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { PersonaPlexConfig } from "../config/types.voice.js";
import { prepareAudioForWhisper } from "./local-stt.js";

const DEFAULT_INSTALL_PATH = path.join(process.env.HOME ?? "/tmp", ".openclaw", "personaplex");
const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8998;
const DEFAULT_WS_PATH = "/api/chat";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VOICE_PROMPT = "NATF2.pt";
const DEFAULT_WS_TEXT_PROMPT =
  "You are OpenClaw, a helpful voice assistant. Answer concisely and naturally. If you are unsure or the request is complex, respond with [[HANDOFF_TO_CLOUD]] instead of guessing.";
const DEFAULT_WS_TEXT_TEMPERATURE = 0.7;
const DEFAULT_WS_TEXT_TOPK = 25;
const DEFAULT_WS_AUDIO_TEMPERATURE = 0.8;
const DEFAULT_WS_AUDIO_TOPK = 250;
const DEFAULT_WS_PAD_MULT = 0;
const DEFAULT_WS_REPETITION_PENALTY_CONTEXT = 64;
const DEFAULT_WS_REPETITION_PENALTY = 1;
const DEFAULT_WS_RESPONSE_IDLE_MS = 900;
const DEFAULT_WS_RESPONSE_START_TIMEOUT_MS = 15_000;
const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_SEED = 42_424_242;
const DEFAULT_CPU_OFFLOAD_THRESHOLD_GB = 40;

const execFileAsync = promisify(execFile);

export type PersonaPlexResult = {
  success: boolean;
  audioPath?: string;
  audioBuffer?: Buffer;
  transcription?: string;
  response?: string;
  error?: string;
  latencyMs?: number;
};

export type ResolvedPersonaPlexConfig = Required<PersonaPlexConfig>;

export type PersonaPlexDependencies = {
  opus: boolean;
  moshi: boolean;
  accelerate: boolean;
};

type PersonaPlexEndpointConfig = NonNullable<PersonaPlexConfig["endpoints"]>[number];

let serverProcess: ChildProcess | null = null;
let serverSslDir: string | null = null;
let idleStopTimer: NodeJS.Timeout | null = null;

function clearIdleStopTimer(): void {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
}

async function processWithPersonaPlexServer(
  audioBuffer: Buffer,
  config: ResolvedPersonaPlexConfig,
): Promise<PersonaPlexResult> {
  const startTime = Date.now();
  const prepared = await prepareAudioForWhisper(audioBuffer);
  if (!prepared.success || !prepared.wav) {
    return {
      success: false,
      error: prepared.error ?? "Audio preparation failed",
      latencyMs: Date.now() - startTime,
    };
  }

  const url = buildPersonaPlexUrl(config, "/s2s");
  const payload = {
    audio: prepared.wav.toString("base64"),
    prompt: config.textPrompt?.trim() || "",
  };

  try {
    const result = await requestOk(url, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: config.timeoutMs,
    });
    if (!result.ok) {
      return {
        success: false,
        error: `PersonaPlex server returned ${result.status}`,
        latencyMs: Date.now() - startTime,
      };
    }
    const raw = result.body ?? "";
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (parsed && parsed.success === false) {
      const rawErr = (parsed as { error?: unknown }).error;
      let errText = "PersonaPlex server error";
      if (typeof rawErr === "string") {
        errText = rawErr;
      } else if (rawErr instanceof Error) {
        errText = rawErr.message;
      } else if (rawErr !== undefined && rawErr !== null) {
        try {
          errText = JSON.stringify(rawErr);
        } catch {
          // ignore
        }
      }
      return {
        success: false,
        error: errText,
        latencyMs: Date.now() - startTime,
      };
    }
    const audioBase64 = (parsed as { audio?: unknown }).audio;
    if (typeof audioBase64 !== "string" || !audioBase64) {
      return {
        success: false,
        error: "PersonaPlex server response missing audio",
        latencyMs: Date.now() - startTime,
      };
    }
    const audioBufferOut = Buffer.from(audioBase64, "base64");
    const responseText = typeof parsed?.text === "string" ? parsed.text : undefined;
    return {
      success: true,
      audioBuffer: audioBufferOut,
      response: responseText,
      transcription: responseText,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      latencyMs: Date.now() - startTime,
    };
  }
}

function isPersonaPlexOggHeaderPage(payload: Buffer): boolean {
  // Ogg Opus stream headers include "OpusHead" and "OpusTags".
  // These pages are necessary for decoding but should not be treated as "response started".
  return payload.includes(Buffer.from("OpusHead")) || payload.includes(Buffer.from("OpusTags"));
}

async function processWithPersonaPlexWebSocket(
  audioBuffer: Buffer,
  config: ResolvedPersonaPlexConfig,
): Promise<PersonaPlexResult> {
  const startTime = Date.now();
  const prepared = await prepareAudioForWhisper(audioBuffer);
  if (!prepared.success || !prepared.wav) {
    return {
      success: false,
      error: prepared.error ?? "Audio preparation failed",
      latencyMs: Date.now() - startTime,
    };
  }

  const oggIn = await convertWavToOggOpus(prepared.wav, { timeoutMs: 30_000 });
  if (!oggIn.success || !oggIn.ogg) {
    return {
      success: false,
      error: oggIn.error ?? "Audio encoding failed",
      latencyMs: Date.now() - startTime,
    };
  }

  const wsUrl = buildPersonaPlexWsUrl(config);

  return await new Promise<PersonaPlexResult>((resolve) => {
    let done = false;
    let handshakeReceived = false;
    let sentInput = false;

    const audioParts: Buffer[] = [];
    const textParts: string[] = [];
    let lastAudioAfterSendAt = 0;
    let gotNonHeaderAudioAfterSend = false;
    let errorText: string | null = null;

    const finish = async (result: PersonaPlexResult) => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(idleTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(overallTimer);
      clearTimeout(startTimer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const ws = new WebSocket(wsUrl, { handshakeTimeout: 5000 });

    const handshakeTimer = setTimeout(() => {
      void finish({
        success: false,
        error: `PersonaPlex websocket handshake timed out (${DEFAULT_WS_HANDSHAKE_TIMEOUT_MS}ms)`,
        latencyMs: Date.now() - startTime,
      });
    }, DEFAULT_WS_HANDSHAKE_TIMEOUT_MS);

    const overallTimer = setTimeout(() => {
      void finish({
        success: false,
        error: `PersonaPlex websocket timed out (${config.timeoutMs}ms)`,
        latencyMs: Date.now() - startTime,
      });
    }, config.timeoutMs);

    const startTimer = setTimeout(() => {
      if (!sentInput || gotNonHeaderAudioAfterSend || done) {
        return;
      }
      void finish({
        success: false,
        error: `PersonaPlex websocket produced no audio (${DEFAULT_WS_RESPONSE_START_TIMEOUT_MS}ms)`,
        latencyMs: Date.now() - startTime,
      });
    }, DEFAULT_WS_RESPONSE_START_TIMEOUT_MS);

    const idleTimer = setInterval(() => {
      if (!sentInput || !gotNonHeaderAudioAfterSend || done) {
        return;
      }
      const now = Date.now();
      if (now - lastAudioAfterSendAt > DEFAULT_WS_RESPONSE_IDLE_MS) {
        const oggOut = Buffer.concat(audioParts);
        void (async () => {
          if (!oggOut.length) {
            await finish({
              success: false,
              error: "PersonaPlex websocket returned empty audio",
              latencyMs: Date.now() - startTime,
            });
            return;
          }

          const wavOut = await convertOggToWav(oggOut, { timeoutMs: 30_000 });
          if (!wavOut.success || !wavOut.wav) {
            await finish({
              success: false,
              error: wavOut.error ?? "Audio decode failed",
              latencyMs: Date.now() - startTime,
            });
            return;
          }

          const responseText = textParts.join("").replace(/\s+/g, " ").trim();
          await finish({
            success: true,
            audioBuffer: wavOut.wav,
            response: responseText || undefined,
            transcription: responseText || undefined,
            latencyMs: Date.now() - startTime,
          });
        })();
      }
    }, 100);
    idleTimer.unref?.();

    ws.on("open", () => {
      // Wait for server handshake byte (0x00) before sending any audio.
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary || done) {
        return;
      }
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (buf.length < 1) {
        return;
      }
      const kind = buf[0];
      const payload = buf.subarray(1);

      if (kind === 0) {
        if (handshakeReceived) {
          return;
        }
        handshakeReceived = true;
        clearTimeout(handshakeTimer);

        if (!sentInput) {
          sentInput = true;
          try {
            ws.send(Buffer.concat([Buffer.from([1]), oggIn.ogg!]));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void finish({
              success: false,
              error: `PersonaPlex websocket send failed: ${message}`,
              latencyMs: Date.now() - startTime,
            });
          }
        }
        return;
      }

      if (kind === 1) {
        // Audio (Ogg Opus pages)
        audioParts.push(payload);
        if (sentInput && !isPersonaPlexOggHeaderPage(payload)) {
          gotNonHeaderAudioAfterSend = true;
          lastAudioAfterSendAt = Date.now();
        }
        return;
      }

      if (kind === 2) {
        // Text token pieces
        if (sentInput) {
          const piece = payload.toString("utf8");
          if (piece) {
            textParts.push(piece);
          }
        }
        return;
      }

      if (kind === 5) {
        errorText = payload.toString("utf8") || errorText;
      }
    });

    ws.on("close", (code) => {
      if (done) {
        return;
      }
      const msg = errorText ? `: ${errorText}` : "";
      void finish({
        success: false,
        error: `PersonaPlex websocket closed (${code})${msg}`,
        latencyMs: Date.now() - startTime,
      });
    });

    ws.on("error", (err) => {
      if (done) {
        return;
      }
      void finish({
        success: false,
        error: `PersonaPlex websocket error: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - startTime,
      });
    });
  });
}

function armIdleStopTimer(config: ResolvedPersonaPlexConfig): void {
  clearIdleStopTimer();
  if (!Number.isFinite(config.idleTimeoutMs) || config.idleTimeoutMs <= 0) {
    return;
  }
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    stopPersonaPlexServer();
  }, config.idleTimeoutMs);
  idleStopTimer.unref?.();
}

export function resolvePersonaPlexConfig(config?: PersonaPlexConfig): ResolvedPersonaPlexConfig {
  const totalMemGb = os.totalmem() / 1024 ** 3;
  const defaultCpuOffload =
    process.platform === "darwin" && totalMemGb < DEFAULT_CPU_OFFLOAD_THRESHOLD_GB;

  const defaultDevice = (() => {
    if (config?.device?.trim()) {
      return config.device.trim();
    }
    if (config?.useGpu === false) {
      return "cpu";
    }
    if (process.platform === "darwin") {
      return "mps";
    }
    return "cuda";
  })();

  return {
    enabled: config?.enabled ?? false,
    installPath: config?.installPath?.trim() || DEFAULT_INSTALL_PATH,
    host: config?.host?.trim() || DEFAULT_HOST,
    port: config?.port ?? DEFAULT_PORT,
    wsPort:
      config?.wsPort ??
      (isLoopbackHost(config?.host?.trim() || DEFAULT_HOST) ? 0 : 1) +
        (config?.port ?? DEFAULT_PORT),
    wsPath: config?.wsPath?.trim() || DEFAULT_WS_PATH,
    useSsl: config?.useSsl ?? true,
    transport: config?.transport ?? "auto",
    endpoints: config?.endpoints ?? [],

    useLocalAssets: config?.useLocalAssets ?? true,

    hfToken: config?.hfToken ?? "",
    useGpu: config?.useGpu ?? true,
    device: defaultDevice,

    dtype: config?.dtype ?? (process.platform === "darwin" ? "fp16" : "bf16"),
    context: config?.context ?? 1024,

    cpuOffload: config?.cpuOffload ?? defaultCpuOffload,
    singleMimi: config?.singleMimi ?? false,

    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    autoStart: config?.autoStart ?? false,
    voicePrompt: config?.voicePrompt?.trim() || "",
    textPrompt: config?.textPrompt?.trim() || "",
    seed: config?.seed ?? DEFAULT_SEED,
  };
}

/**
 * Check if PersonaPlex is installed.
 * Looks for the moshi library and model weights in the install path.
 */
export function isPersonaPlexInstalled(config: ResolvedPersonaPlexConfig): boolean {
  const moshiPath = path.join(config.installPath, "moshi");
  const moshiProject = path.join(moshiPath, "pyproject.toml");
  const venvPython = resolveVenvPython(config);

  // Model weights are downloaded on first run, so only check repo + venv.
  return (
    existsSync(moshiPath) &&
    (existsSync(moshiProject) || existsSync(path.join(moshiPath, "setup.py"))) &&
    existsSync(venvPython)
  );
}

function resolveVenvPython(config: ResolvedPersonaPlexConfig): string {
  return path.join(config.installPath, ".venv", "bin", "python");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function isOpusInstalled(): boolean {
  const candidates = [
    "/opt/homebrew/lib/libopus.dylib",
    "/usr/local/lib/libopus.dylib",
    "/usr/lib/libopus.dylib",
    "/usr/lib/x86_64-linux-gnu/libopus.so",
    "/usr/lib/aarch64-linux-gnu/libopus.so",
    "/usr/lib64/libopus.so",
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

async function checkPythonModule(pythonPath: string, moduleName: string): Promise<boolean> {
  if (!existsSync(pythonPath)) {
    return false;
  }
  try {
    await execFileAsync(pythonPath, ["-c", `import ${moduleName}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function checkPersonaPlexDependencies(
  config: ResolvedPersonaPlexConfig,
): Promise<PersonaPlexDependencies> {
  const pythonPath = resolveVenvPython(config);
  const [moshi, accelerate] = await Promise.all([
    checkPythonModule(pythonPath, "moshi"),
    checkPythonModule(pythonPath, "accelerate"),
  ]);
  return {
    opus: isOpusInstalled(),
    moshi,
    accelerate,
  };
}

function buildPersonaPlexUrl(config: ResolvedPersonaPlexConfig, pathSuffix: string): URL {
  const protocol = config.useSsl ? "https" : "http";
  return new URL(`${protocol}://${config.host}:${config.port}${pathSuffix}`);
}

function normalizeWsPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_WS_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildPersonaPlexWsUrl(config: ResolvedPersonaPlexConfig): URL {
  const protocol = config.useSsl ? "wss" : "ws";
  const pathname = normalizeWsPath(config.wsPath || DEFAULT_WS_PATH);
  const url = new URL(`${protocol}://${config.host}:${config.wsPort}${pathname}`);

  // These query parameters match the upstream PersonaPlex Web UI expectations.
  // Some server builds fail fast if they are missing.
  url.searchParams.set("text_temperature", String(DEFAULT_WS_TEXT_TEMPERATURE));
  url.searchParams.set("text_topk", String(DEFAULT_WS_TEXT_TOPK));
  url.searchParams.set("audio_temperature", String(DEFAULT_WS_AUDIO_TEMPERATURE));
  url.searchParams.set("audio_topk", String(DEFAULT_WS_AUDIO_TOPK));
  url.searchParams.set("pad_mult", String(DEFAULT_WS_PAD_MULT));
  url.searchParams.set("repetition_penalty_context", String(DEFAULT_WS_REPETITION_PENALTY_CONTEXT));
  url.searchParams.set("repetition_penalty", String(DEFAULT_WS_REPETITION_PENALTY));

  const seed =
    typeof config.seed === "number" && Number.isFinite(config.seed)
      ? Math.trunc(config.seed)
      : Math.floor(Math.random() * 1_000_000);
  url.searchParams.set("text_seed", String(seed));
  url.searchParams.set("audio_seed", String(seed));

  // NOTE: Spark PersonaPlex currently requires a non-empty text_prompt, even if you want "no prompt".
  const textPrompt = config.textPrompt.trim() || DEFAULT_WS_TEXT_PROMPT;
  url.searchParams.set("text_prompt", textPrompt);

  const voicePrompt = config.voicePrompt.trim() || DEFAULT_VOICE_PROMPT;
  url.searchParams.set("voice_prompt", voicePrompt);

  return url;
}

async function convertWavToOggOpus(
  wavBuffer: Buffer,
  opts: { timeoutMs: number },
): Promise<{ success: boolean; ogg?: Buffer; error?: string }> {
  const tempDir = path.join(tmpdir(), "openclaw-personaplex-ws");
  mkdirSync(tempDir, { recursive: true });
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `ws-in-${timestamp}.wav`);
  const outputPath = path.join(tempDir, `ws-in-${timestamp}.ogg`);

  try {
    writeFileSync(inputPath, wavBuffer);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-application",
        "voip",
        "-frame_duration",
        "20",
        "-b:a",
        "64k",
        "-f",
        "ogg",
        outputPath,
      ],
      { timeout: opts.timeoutMs },
    );
    return { success: true, ogg: readFileSync(outputPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `ffmpeg wav->ogg failed: ${message}` };
  } finally {
    try {
      unlinkSync(inputPath);
    } catch {
      // ignore
    }
    try {
      unlinkSync(outputPath);
    } catch {
      // ignore
    }
  }
}

async function convertOggToWav(
  oggBuffer: Buffer,
  opts: { timeoutMs: number },
): Promise<{ success: boolean; wav?: Buffer; error?: string }> {
  const tempDir = path.join(tmpdir(), "openclaw-personaplex-ws");
  mkdirSync(tempDir, { recursive: true });
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `ws-out-${timestamp}.ogg`);
  const outputPath = path.join(tempDir, `ws-out-${timestamp}.wav`);

  try {
    writeFileSync(inputPath, oggBuffer);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outputPath,
      ],
      { timeout: opts.timeoutMs },
    );
    return { success: true, wav: readFileSync(outputPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `ffmpeg ogg->wav failed: ${message}` };
  } finally {
    try {
      unlinkSync(inputPath);
    } catch {
      // ignore
    }
    try {
      unlinkSync(outputPath);
    } catch {
      // ignore
    }
  }
}

async function requestOk(
  url: URL,
  opts: { method: "GET" | "POST"; body?: string; timeoutMs: number },
): Promise<{ ok: boolean; status: number; body?: string }> {
  return new Promise((resolve, reject) => {
    const baseOptions = {
      method: opts.method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: opts.body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(opts.body),
          }
        : undefined,
      timeout: opts.timeoutMs,
    };

    const request = (url.protocol === "https:" ? https : http).request(
      url.protocol === "https:" ? { ...baseOptions, rejectUnauthorized: false } : baseOptions,
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, body: raw });
        });
      },
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Request timed out"));
    });
    if (opts.body) {
      request.write(opts.body);
    }
    request.end();
  });
}

type PersonaPlexEndpointSelection = {
  config: ResolvedPersonaPlexConfig;
  transport: "offline" | "server";
};

const PERSONAPLEX_HEALTH_TTL_MS = 10_000;
const personaplexHealthCache = new Map<string, { ok: boolean; checkedAt: number }>();

function resolveEndpointTransport(
  config: ResolvedPersonaPlexConfig,
  transport?: "auto" | "offline" | "server",
): "offline" | "server" {
  if (transport === "offline" || transport === "server") {
    return transport;
  }
  if (config.transport === "offline" || config.transport === "server") {
    return config.transport;
  }
  return isLoopbackHost(config.host) ? "offline" : "server";
}

function applyPersonaPlexEndpoint(
  base: ResolvedPersonaPlexConfig,
  endpoint?: PersonaPlexEndpointConfig,
): ResolvedPersonaPlexConfig {
  if (!endpoint) {
    return base;
  }
  return {
    ...base,
    host: endpoint.host?.trim() || base.host,
    port: endpoint.port ?? base.port,
    wsPort: endpoint.wsPort ?? base.wsPort,
    wsPath: endpoint.wsPath?.trim() || base.wsPath,
    useSsl: endpoint.useSsl ?? base.useSsl,
    transport: endpoint.transport ?? base.transport,
  };
}

async function checkPersonaPlexServerHealth(
  config: ResolvedPersonaPlexConfig,
  healthPath: string,
  timeoutMs: number,
  cacheTtlMs: number,
): Promise<boolean> {
  const cacheKey = `${config.host}:${config.port}:${config.useSsl}:${healthPath}`;
  const now = Date.now();
  const cached = personaplexHealthCache.get(cacheKey);
  if (cached && now - cached.checkedAt < cacheTtlMs) {
    return cached.ok;
  }
  try {
    const url = buildPersonaPlexUrl(config, healthPath);
    const result = await requestOk(url, { method: "GET", timeoutMs });
    personaplexHealthCache.set(cacheKey, { ok: result.ok, checkedAt: now });
    return result.ok;
  } catch {
    personaplexHealthCache.set(cacheKey, { ok: false, checkedAt: now });
    return false;
  }
}

export async function selectPersonaPlexEndpoint(
  config: ResolvedPersonaPlexConfig,
): Promise<PersonaPlexEndpointSelection | null> {
  const endpoints = config.endpoints?.length ? config.endpoints : [undefined];
  const ordered = [...endpoints].toSorted((a, b) => {
    const aPriority = a?.priority ?? 0;
    const bPriority = b?.priority ?? 0;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return (a?.host ?? "").localeCompare(b?.host ?? "");
  });

  for (const endpoint of ordered) {
    const merged = applyPersonaPlexEndpoint(config, endpoint);
    const transport = resolveEndpointTransport(merged, endpoint?.transport);
    if (transport === "offline") {
      if (isPersonaPlexInstalled(merged)) {
        return { config: merged, transport };
      }
      continue;
    }
    const healthPath = endpoint?.healthPath?.trim() || "/";
    const timeoutMs = endpoint?.healthTimeoutMs ?? 2000;
    const cacheTtlMs = endpoint?.healthCacheTtlMs ?? PERSONAPLEX_HEALTH_TTL_MS;
    if (await checkPersonaPlexServerHealth(merged, healthPath, timeoutMs, cacheTtlMs)) {
      return { config: merged, transport };
    }
  }

  return null;
}

/**
 * Check if PersonaPlex server is running.
 */
export async function isPersonaPlexRunning(config: ResolvedPersonaPlexConfig): Promise<boolean> {
  try {
    // moshi.server does not expose a /health endpoint upstream.
    // We use GET / as a lightweight readiness probe.
    const url = buildPersonaPlexUrl(config, "/");
    const result = await requestOk(url, { method: "GET", timeoutMs: 2000 });
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Get HuggingFace token from environment or keychain.
 */
export async function getHfToken(config: ResolvedPersonaPlexConfig): Promise<string | null> {
  // First check config
  if (config.hfToken) {
    return config.hfToken;
  }

  // Then check environment
  const envToken = process.env.HF_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  // Try macOS keychain
  try {
    const { execSync } = await import("node:child_process");
    const token = execSync(
      "security find-generic-password -s openclaw -a HF_TOKEN -w 2>/dev/null",
      { encoding: "utf-8" },
    ).trim();
    if (token) {
      return token;
    }
  } catch {
    // Keychain lookup failed
  }

  return null;
}

/**
 * Start the PersonaPlex server.
 */
export async function startPersonaPlexServer(
  config: ResolvedPersonaPlexConfig,
): Promise<{ success: boolean; error?: string }> {
  if (await isPersonaPlexRunning(config)) {
    armIdleStopTimer(config);
    return { success: true };
  }

  if (!isPersonaPlexInstalled(config)) {
    return { success: false, error: "PersonaPlex not installed" };
  }

  const deps = await checkPersonaPlexDependencies(config);
  if (!deps.opus) {
    return { success: false, error: "Opus codec not installed (libopus)" };
  }
  if (!deps.moshi) {
    return { success: false, error: "moshi package not installed in PersonaPlex venv" };
  }
  if (config.cpuOffload && !deps.accelerate) {
    return { success: false, error: "accelerate package required for cpuOffload" };
  }

  const hfToken = await getHfToken(config);
  if (!hfToken && !config.useLocalAssets) {
    return { success: false, error: "HuggingFace token not found" };
  }

  const venvPython = resolveVenvPython(config);
  if (!existsSync(venvPython)) {
    return { success: false, error: "PersonaPlex venv not found (missing .venv/bin/python)" };
  }

  // If the port is already bound (stale process), try to free it.
  // This avoids EADDRINUSE when OpenClaw restarts.
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${config.port}`], {
      timeout: 2000,
    });
    const pids = stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pidStr of pids) {
      const pid = Number(pidStr);
      if (!Number.isFinite(pid) || pid <= 1) {
        continue;
      }
      try {
        process.kill(pid);
      } catch {
        // ignore
      }
    }
  } catch {
    // lsof not available or no listeners
  }

  if (serverSslDir) {
    try {
      rmSync(serverSslDir, { recursive: true, force: true });
    } catch {
      // Ignore stale SSL dir cleanup
    }
    serverSslDir = null;
  }

  if (config.useSsl) {
    serverSslDir = mkdtempSync(path.join(tmpdir(), "openclaw-personaplex-ssl-"));
  }

  const args = ["-m", "moshi.server", "--port", String(config.port)];
  if (config.useSsl && serverSslDir) {
    args.push("--ssl", serverSslDir);
  }

  // Device selection (avoid upstream default of cuda)
  if (config.device) {
    args.push("--device", config.device);
  }

  // Local assets (avoid HF downloads)
  const modelDir = path.join(config.installPath, "models", "personaplex-7b-v1");
  const localMoshi = path.join(modelDir, "model.safetensors");
  const localMimi = path.join(modelDir, "tokenizer-e351c8d8-checkpoint125.safetensors");
  const localTokenizer = path.join(modelDir, "tokenizer_spm_32k_3.model");
  const localVoices = path.join(modelDir, "voices");
  const localStatic = path.join(modelDir, "dist");
  const hasLocalAssets =
    config.useLocalAssets &&
    existsSync(localMoshi) &&
    existsSync(localMimi) &&
    existsSync(localTokenizer) &&
    existsSync(localVoices) &&
    existsSync(localStatic);

  if (hasLocalAssets) {
    args.push(
      "--moshi-weight",
      localMoshi,
      "--mimi-weight",
      localMimi,
      "--tokenizer",
      localTokenizer,
      "--voice-prompt-dir",
      localVoices,
      "--static",
      localStatic,
    );
  }

  if (config.singleMimi) {
    args.push("--single-mimi");
  }

  if (config.cpuOffload) {
    args.push("--cpu-offload");
  }

  const env = {
    ...process.env,
    ...(hfToken ? { HF_TOKEN: hfToken } : {}),

    // Mac profile controls (these are consumed by our patched moshi loader)
    MOSHI_DTYPE: config.dtype,
    MOSHI_CONTEXT: String(config.context),

    // Avoid accidental network pulls if local assets are present
    ...(hasLocalAssets
      ? {
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_DATASETS_OFFLINE: "1",
        }
      : {}),
  };

  serverProcess = spawn(venvPython, args, {
    cwd: config.installPath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Wait for server to be ready
  const maxWait = Math.max(60_000, config.timeoutMs);
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isPersonaPlexRunning(config)) {
      armIdleStopTimer(config);
      return { success: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Timeout - kill server
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (serverSslDir) {
    try {
      rmSync(serverSslDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    serverSslDir = null;
  }

  return { success: false, error: "Server startup timed out" };
}

/**
 * Stop the PersonaPlex server.
 */
export function stopPersonaPlexServer(): void {
  clearIdleStopTimer();
  if (serverProcess) {
    try {
      // When spawned with detached:true, kill the whole process group.
      if (serverProcess.pid) {
        try {
          process.kill(-serverProcess.pid);
        } catch {
          serverProcess.kill();
        }
      } else {
        serverProcess.kill();
      }
    } catch {
      // Ignore
    }
    serverProcess = null;
  }
  if (serverSslDir) {
    try {
      rmSync(serverSslDir, { recursive: true, force: true });
    } catch {
      // Ignore SSL cleanup errors
    }
    serverSslDir = null;
  }
}

async function processWithPersonaPlexOffline(
  audioBuffer: Buffer,
  config: ResolvedPersonaPlexConfig,
): Promise<PersonaPlexResult> {
  const startTime = Date.now();
  const venvPython = resolveVenvPython(config);
  if (!existsSync(venvPython)) {
    return { success: false, error: "PersonaPlex venv not found (missing .venv/bin/python)" };
  }

  const deps = await checkPersonaPlexDependencies(config);
  if (!deps.opus) {
    return { success: false, error: "Opus codec not installed (libopus)" };
  }
  if (!deps.moshi) {
    return { success: false, error: "moshi package not installed in PersonaPlex venv" };
  }
  if (config.cpuOffload && !deps.accelerate) {
    return { success: false, error: "accelerate package required for cpuOffload" };
  }

  const hfToken = await getHfToken(config);
  if (!hfToken && !config.useLocalAssets) {
    return { success: false, error: "HuggingFace token not found" };
  }

  const tempDir = path.join(tmpdir(), "openclaw-personaplex");
  mkdirSync(tempDir, { recursive: true });
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `s2s-in-${timestamp}.wav`);
  const outputPath = path.join(tempDir, `s2s-out-${timestamp}.wav`);
  const outputText = path.join(tempDir, `s2s-out-${timestamp}.json`);

  try {
    const prepared = await prepareAudioForWhisper(audioBuffer);
    if (!prepared.success || !prepared.wav) {
      return {
        success: false,
        error: prepared.error ?? "Audio preparation failed",
        latencyMs: Date.now() - startTime,
      };
    }

    writeFileSync(inputPath, prepared.wav);

    const voicePrompt = config.voicePrompt?.trim() || DEFAULT_VOICE_PROMPT;

    const args = [
      "-m",
      "moshi.offline",
      "--voice-prompt",
      voicePrompt,
      "--input-wav",
      inputPath,
      "--seed",
      String(config.seed),
      "--output-wav",
      outputPath,
      "--output-text",
      outputText,
    ];

    // Device selection (avoid upstream default of cuda)
    if (config.device) {
      args.push("--device", config.device);
    }

    // Prefer local assets for offline as well
    const modelDir = path.join(config.installPath, "models", "personaplex-7b-v1");
    const localMoshi = path.join(modelDir, "model.safetensors");
    const localMimi = path.join(modelDir, "tokenizer-e351c8d8-checkpoint125.safetensors");
    const localTokenizer = path.join(modelDir, "tokenizer_spm_32k_3.model");
    const localVoices = path.join(modelDir, "voices");
    const hasLocalAssets =
      config.useLocalAssets &&
      existsSync(localMoshi) &&
      existsSync(localMimi) &&
      existsSync(localTokenizer) &&
      existsSync(localVoices);

    if (hasLocalAssets) {
      args.push(
        "--moshi-weight",
        localMoshi,
        "--mimi-weight",
        localMimi,
        "--tokenizer",
        localTokenizer,
        "--voice-prompt-dir",
        localVoices,
      );
    }

    if (config.textPrompt) {
      args.push("--text-prompt", config.textPrompt);
    }
    if (config.cpuOffload) {
      args.push("--cpu-offload");
    }

    const env = {
      ...process.env,
      ...(hfToken ? { HF_TOKEN: hfToken } : {}),
      MOSHI_DTYPE: config.dtype,
      MOSHI_CONTEXT: String(config.context),
      ...(hasLocalAssets
        ? {
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            HF_DATASETS_OFFLINE: "1",
          }
        : {}),
    };

    await execFileAsync(venvPython, args, {
      cwd: config.installPath,
      env,
      timeout: config.timeoutMs,
    });

    const outputBuffer = readFileSync(outputPath);
    const parsedText = readPersonaPlexOutputText(outputText);
    return {
      success: true,
      audioPath: outputPath,
      audioBuffer: outputBuffer,
      transcription: parsedText.transcription,
      response: parsedText.response,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      latencyMs: Date.now() - startTime,
    };
  } finally {
    try {
      unlinkSync(inputPath);
    } catch {
      // Ignore cleanup errors
    }
    try {
      unlinkSync(outputText);
    } catch {
      // Ignore cleanup errors
    }
  }
}

function readPersonaPlexOutputText(pathname: string): {
  transcription?: string;
  response?: string;
} {
  try {
    if (!existsSync(pathname)) {
      return {};
    }
    const raw = readFileSync(pathname, "utf-8").trim();
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const pickText = (value: unknown): string | undefined => {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed ? trimmed : undefined;
        }
        if (Array.isArray(value)) {
          const joined = value
            .map((entry) => pickText(entry))
            .filter(Boolean)
            .join(" ")
            .trim();
          return joined || undefined;
        }
        if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text.trim() || undefined;
          }
          if (typeof record.content === "string") {
            return record.content.trim() || undefined;
          }
          if (Array.isArray(record.segments)) {
            const joined = record.segments
              .map((segment) => pickText(segment))
              .filter(Boolean)
              .join(" ")
              .trim();
            return joined || undefined;
          }
        }
        return undefined;
      };

      const transcription =
        pickText(parsed.transcription) ??
        pickText(parsed.transcript) ??
        pickText(parsed.input_text) ??
        pickText(parsed.input);
      const response =
        pickText(parsed.response) ??
        pickText(parsed.output_text) ??
        pickText(parsed.text) ??
        pickText(parsed.output);

      return { transcription, response: response ?? transcription };
    } catch {
      // Not JSON, treat as plain text response.
      return { response: raw };
    }
  } catch {
    return {};
  }
}

/**
 * Process audio through PersonaPlex S2S.
 */
export async function processWithPersonaPlex(
  audioBuffer: Buffer,
  config: ResolvedPersonaPlexConfig,
  transport: "offline" | "server" = "offline",
): Promise<PersonaPlexResult> {
  if (transport === "server") {
    // Prefer realtime WebSocket when available, but fall back to the HTTP /s2s wrapper
    // before falling all the way back to the STT → LLM → TTS pipeline.
    const wsResult = await processWithPersonaPlexWebSocket(audioBuffer, config);
    if (wsResult.success) {
      return wsResult;
    }

    const httpResult = await processWithPersonaPlexServer(audioBuffer, config);
    if (httpResult.success) {
      return httpResult;
    }

    const wsErr = wsResult.error ? `ws=${wsResult.error}` : "ws=unknown";
    const httpErr = httpResult.error ? `http=${httpResult.error}` : "http=unknown";
    return {
      ...httpResult,
      error: `PersonaPlex server failed (${wsErr}; ${httpErr})`,
    };
  }
  // Programmatic S2S requests use moshi.offline so we can honor persona prompts.
  // The moshi.server path remains available for interactive sessions.
  return processWithPersonaPlexOffline(audioBuffer, config);
}

/**
 * Get PersonaPlex status.
 */
export async function getPersonaPlexStatus(config: ResolvedPersonaPlexConfig): Promise<{
  installed: boolean;
  running: boolean;
  device?: string;
  hasToken: boolean;
}> {
  const isRemote = !isLoopbackHost(config.host);
  const installed = isRemote ? true : isPersonaPlexInstalled(config);
  const endpoints = config.endpoints ?? [];
  const hasServerEndpoint =
    config.transport === "server" ||
    (config.transport === "auto" && isRemote) ||
    endpoints.some((endpoint) => {
      const host = endpoint.host?.trim() || config.host;
      const transport = endpoint.transport ?? config.transport;
      if (transport === "server") {
        return true;
      }
      if (transport === "offline") {
        return false;
      }
      return !isLoopbackHost(host);
    });
  const selection = hasServerEndpoint ? await selectPersonaPlexEndpoint(config) : null;
  const running = hasServerEndpoint
    ? selection?.transport === "server"
    : await isPersonaPlexRunning(config);
  const hasToken = isRemote ? true : (await getHfToken(config)) !== null || config.useLocalAssets;

  // moshi.server does not expose a structured health payload upstream.
  // If running, report the configured device.
  const device = running ? config.device : undefined;

  return { installed, running, device, hasToken };
}
