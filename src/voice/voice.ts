/**
 * Voice mode orchestrator.
 *
 * Primary mode: PersonaPlex S2S (native speech-to-speech)
 * Fallback mode: STT → LLM → TTS pipeline
 *
 * PersonaPlex is used as the primary path when available.
 * The traditional pipeline is only used when PersonaPlex is unavailable or fails.
 */

import net from "node:net";
import type {
  VoiceConfig,
  VoiceMode,
  VoiceSessionState,
  ResolvedVoiceConfig,
} from "../config/types.voice.js";
import {
  resolveWhisperConfig,
  transcribeWithWhisper,
  isWhisperAvailable,
  isFfmpegAvailable,
} from "./local-stt.js";
import {
  resolveLocalTtsConfig,
  synthesizeWithLocalTts,
  synthesizeWithMacos,
  isSagAvailable,
  type LocalTtsResult,
} from "./local-tts.js";
import {
  checkPersonaPlexDependencies,
  getPersonaPlexStatus,
  resolvePersonaPlexConfig,
  processWithPersonaPlex,
  selectPersonaPlexEndpoint,
} from "./personaplex.js";
import {
  analyzeComplexity,
  detectSensitiveData,
  resolveRouterConfig,
  routeVoiceRequest,
  type RouterDecision,
} from "./router.js";

const DEFAULT_MODE: VoiceMode = "personaplex"; // PersonaPlex as default
const DEFAULT_BUFFER_MS = 100;
const DEFAULT_MAX_RECORDING_SECONDS = 60;
const DEFAULT_VAD_SENSITIVITY = 0.5;
const DEFAULT_NETCHECK_TTL_SECONDS = 30;
const DEFAULT_NETCHECK_TIMEOUT_SECONDS = 0.5;
const DEFAULT_NETCHECK_HOSTS = "1.1.1.1:53,8.8.8.8:53";
const HANDOFF_TOKEN_RE = /\[\[\s*handoff_to_cloud\s*\]\]/i;

type HostCheck = { host: string; port: number };
let lastNetCheckAt = 0;
let lastNetOnline = true;

function readEnvBool(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseHosts(raw: string): HostCheck[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, portRaw] = entry.split(":");
      const port = Number(portRaw ?? "53");
      return { host: host.trim(), port: Number.isFinite(port) ? port : 53 };
    });
}

async function checkHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function isOffline(): Promise<boolean> {
  if (
    readEnvBool("OPENCLAW_OFFLINE") ||
    readEnvBool("ROUTER_FORCE_LOCAL") ||
    readEnvBool("ROUTER_OFFLINE")
  ) {
    return true;
  }

  const ttlSeconds = Number(process.env.ROUTER_NETCHECK_TTL ?? DEFAULT_NETCHECK_TTL_SECONDS);
  const timeoutSeconds = Number(
    process.env.ROUTER_NETCHECK_TIMEOUT ?? DEFAULT_NETCHECK_TIMEOUT_SECONDS,
  );
  const ttlMs = Math.max(0, ttlSeconds) * 1000;
  const timeoutMs = Math.max(0, timeoutSeconds) * 1000;
  const now = Date.now();
  if (ttlMs > 0 && now - lastNetCheckAt < ttlMs) {
    return !lastNetOnline;
  }
  lastNetCheckAt = now;
  lastNetOnline = false;

  const hosts = parseHosts(process.env.ROUTER_NETCHECK_HOSTS ?? DEFAULT_NETCHECK_HOSTS);
  for (const { host, port } of hosts) {
    if (await checkHost(host, port, timeoutMs)) {
      lastNetOnline = true;
      break;
    }
  }

  return !lastNetOnline;
}

export type VoiceProcessResult = {
  success: boolean;
  sessionId: string;
  transcription?: string;
  response?: string;
  audioPath?: string;
  audioBuffer?: Buffer;
  routerDecision?: RouterDecision;
  error?: string;
  timings?: {
    sttMs?: number;
    routingMs?: number;
    llmMs?: number;
    ttsMs?: number;
    totalMs: number;
  };
};

function pickTextForRouting(input?: string | null): string {
  if (!input) {
    return "";
  }
  return input.replace(/\s+/g, " ").trim();
}

function hasHandoffToken(text?: string | null): boolean {
  if (!text) {
    return false;
  }
  return HANDOFF_TOKEN_RE.test(text);
}

export type VoiceCapabilities = {
  whisperAvailable: boolean;
  ffmpegAvailable: boolean;
  sagAvailable: boolean;
  sagAuthenticated: boolean;
  macosSayAvailable: boolean;
  personaplexAvailable: boolean;
  personaplexInstalled: boolean;
  personaplexRunning: boolean;
  personaplexDeps: {
    opus: boolean;
    moshi: boolean;
    accelerate: boolean;
  };
};

/**
 * Resolve voice configuration with defaults.
 * PersonaPlex S2S is the default mode - STT/TTS are only fallbacks.
 */
export function resolveVoiceConfig(config?: VoiceConfig): ResolvedVoiceConfig {
  const resolvedPersonaPlex = resolvePersonaPlexConfig(config?.personaplex);
  return {
    mode: config?.mode ?? DEFAULT_MODE, // "personaplex" is default
    enabled: config?.enabled ?? false,
    sttProvider: config?.sttProvider ?? "whisper", // Fallback STT
    ttsProvider: config?.ttsProvider ?? "macos", // Fallback TTS (macos say is reliable)
    streaming: config?.streaming ?? false,
    bufferMs: config?.bufferMs ?? DEFAULT_BUFFER_MS,
    maxRecordingSeconds: config?.maxRecordingSeconds ?? DEFAULT_MAX_RECORDING_SECONDS,
    vadSensitivity: config?.vadSensitivity ?? DEFAULT_VAD_SENSITIVITY,
    whisper: resolveWhisperConfig(config?.whisper),
    localTts: resolveLocalTtsConfig(config?.localTts),
    router: resolveRouterConfig(config?.router),
    personaplex: {
      ...resolvedPersonaPlex,
      enabled: config?.personaplex?.enabled ?? true, // Enabled by default
      autoStart: config?.personaplex?.autoStart ?? true, // Auto-start by default
    },
  };
}

/**
 * Check voice mode capabilities.
 */
export async function checkVoiceCapabilities(
  config: ResolvedVoiceConfig,
): Promise<VoiceCapabilities> {
  const [
    whisperAvailable,
    ffmpegAvailable,
    sagStatus,
    personaplexDeps,
    personaplexStatus,
    personaplexSelection,
  ] = await Promise.all([
    isWhisperAvailable(config.whisper),
    isFfmpegAvailable(),
    isSagAvailable(),
    checkPersonaPlexDependencies(config.personaplex),
    getPersonaPlexStatus(config.personaplex),
    selectPersonaPlexEndpoint(config.personaplex),
  ]);

  // Check for macOS say
  const { isMacosSayAvailable } = await import("./local-tts.js");
  const macosSayAvailable = isMacosSayAvailable();

  const usingServer = personaplexSelection?.transport === "server";
  const personaplexInstalled = usingServer ? true : personaplexStatus.installed;
  const personaplexRunning = usingServer ? true : personaplexStatus.running;
  const depsOk = usingServer
    ? true
    : personaplexDeps.opus &&
      personaplexDeps.moshi &&
      (!config.personaplex.cpuOffload || personaplexDeps.accelerate);
  const personaplexAvailable = config.personaplex.enabled
    ? usingServer
      ? true
      : personaplexInstalled && depsOk && personaplexStatus.hasToken
    : false;

  return {
    whisperAvailable,
    ffmpegAvailable,
    sagAvailable: sagStatus.available,
    sagAuthenticated: sagStatus.authenticated,
    macosSayAvailable,
    personaplexAvailable,
    personaplexInstalled,
    personaplexRunning,
    personaplexDeps,
  };
}

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new voice session state.
 */
export function createVoiceSession(mode: VoiceMode): VoiceSessionState {
  return {
    sessionId: generateSessionId(),
    mode,
    isRecording: false,
    isProcessing: false,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

type FallbackOverride = {
  model?: string;
  thinking?: string;
  reason?: string;
  complexityScore?: number;
  sensitiveDetected?: boolean;
};

async function runFallbackPipeline(params: {
  audioBuffer?: Buffer;
  transcription?: string;
  config: ResolvedVoiceConfig;
  llmInvoke: (text: string, model?: string, thinking?: string) => Promise<string>;
  sessionId: string;
  startTime: number;
  overrides?: FallbackOverride;
}): Promise<VoiceProcessResult> {
  const timings: VoiceProcessResult["timings"] = { totalMs: 0 };
  let transcription = pickTextForRouting(params.transcription);

  if (!transcription) {
    if (!params.audioBuffer) {
      return {
        success: false,
        sessionId: params.sessionId,
        error: "Missing audio for voice fallback.",
        timings: { ...timings, totalMs: Date.now() - params.startTime },
      };
    }
    const sttStart = Date.now();
    let sttResult: { success: boolean; text?: string; error?: string };

    if (params.config.sttProvider === "whisper") {
      const whisperReady = await isWhisperAvailable(params.config.whisper);
      if (!whisperReady) {
        return {
          success: false,
          sessionId: params.sessionId,
          error:
            "Whisper STT is not available, install whisper-cpp and the model file before using voice fallback.",
          timings: { ...timings, totalMs: Date.now() - params.startTime },
        };
      }
    }

    switch (params.config.sttProvider) {
      case "whisper":
        sttResult = await transcribeWithWhisper(params.audioBuffer, params.config.whisper);
        break;
      case "openai":
        return {
          success: false,
          sessionId: params.sessionId,
          error: "OpenAI STT provider is not implemented.",
          timings: { ...timings, totalMs: Date.now() - params.startTime },
        };
      default:
        sttResult = await transcribeWithWhisper(params.audioBuffer, params.config.whisper);
    }

    timings.sttMs = Date.now() - sttStart;

    if (!sttResult.success || !sttResult.text) {
      return {
        success: false,
        sessionId: params.sessionId,
        error: sttResult.error ?? "STT failed with no error message",
        timings: { ...timings, totalMs: Date.now() - params.startTime },
      };
    }

    transcription = pickTextForRouting(sttResult.text);
  }

  if (!transcription) {
    return {
      success: false,
      sessionId: params.sessionId,
      error: "Empty transcript",
      timings: { ...timings, totalMs: Date.now() - params.startTime },
    };
  }

  const routingStart = Date.now();
  let routerDecision: RouterDecision;
  if (params.overrides?.model) {
    const model = params.overrides.model;
    const route = model.startsWith("ollama/") ? "local" : "cloud";
    routerDecision = {
      route,
      reason: params.overrides.reason ?? "override",
      sensitiveDetected: params.overrides.sensitiveDetected ?? false,
      complexityScore: params.overrides.complexityScore ?? 0,
      model,
      thinking: params.overrides.thinking,
    };
  } else {
    routerDecision = routeVoiceRequest(transcription, params.config.router);
  }
  timings.routingMs = Date.now() - routingStart;

  if (await isOffline()) {
    routerDecision = {
      ...routerDecision,
      route: "local",
      reason: "offline",
      model: params.config.router.localModel,
      thinking: "none",
    };
  }

  const llmStart = Date.now();
  let response: string;
  try {
    response = await params.llmInvoke(transcription, routerDecision.model, routerDecision.thinking);
  } catch (err) {
    return {
      success: false,
      sessionId: params.sessionId,
      transcription,
      routerDecision,
      error: `LLM invocation failed: ${(err as Error).message}`,
      timings: { ...timings, totalMs: Date.now() - params.startTime },
    };
  }
  timings.llmMs = Date.now() - llmStart;

  const ttsStart = Date.now();
  let ttsResult: LocalTtsResult;

  switch (params.config.ttsProvider) {
    case "elevenlabs":
      ttsResult = await synthesizeWithLocalTts(response, params.config.localTts);
      break;
    case "macos":
      ttsResult = await synthesizeWithMacos(response, params.config.localTts);
      break;
    case "openai":
      return {
        success: false,
        sessionId: params.sessionId,
        transcription,
        response,
        routerDecision,
        error: "OpenAI TTS provider is not implemented.",
        timings: { ...timings, totalMs: Date.now() - params.startTime },
      };
    case "edge":
      return {
        success: false,
        sessionId: params.sessionId,
        transcription,
        response,
        routerDecision,
        error: "Edge TTS provider is not implemented.",
        timings: { ...timings, totalMs: Date.now() - params.startTime },
      };
    default:
      ttsResult = await synthesizeWithLocalTts(response, params.config.localTts);
  }

  timings.ttsMs = Date.now() - ttsStart;

  if (!ttsResult.success) {
    return {
      success: false,
      sessionId: params.sessionId,
      transcription,
      response,
      routerDecision,
      error: `TTS failed: ${ttsResult.error}`,
      timings: { ...timings, totalMs: Date.now() - params.startTime },
    };
  }

  timings.totalMs = Date.now() - params.startTime;

  return {
    success: true,
    sessionId: params.sessionId,
    transcription,
    response,
    audioPath: ttsResult.audioPath,
    audioBuffer: ttsResult.audioBuffer,
    routerDecision,
    timings,
  };
}

/**
 * Process voice input through PersonaPlex S2S (primary) or fallback pipeline.
 *
 * Primary path: PersonaPlex S2S (audio in → audio out, native)
 * Fallback path: STT → LLM → TTS (only when PersonaPlex unavailable)
 *
 * @param audioBuffer - Raw audio data (WAV or webm format - auto-converted)
 * @param config - Voice configuration
 * @param llmInvoke - Function to invoke the LLM (only used in fallback mode)
 * @returns Processing result
 */
export async function processVoiceInput(
  audioBuffer: Buffer,
  config: ResolvedVoiceConfig,
  llmInvoke: (text: string, model?: string, thinking?: string) => Promise<string>,
): Promise<VoiceProcessResult> {
  const sessionId = generateSessionId();
  const startTime = Date.now();

  // PRIMARY PATH: Try PersonaPlex S2S first (native speech-to-speech)
  if (config.mode === "personaplex" || config.mode === "hybrid") {
    const personaplexConfig = resolvePersonaPlexConfig(config.personaplex);

    if (personaplexConfig.enabled) {
      const selected = await selectPersonaPlexEndpoint(personaplexConfig);
      if (!selected) {
        // PersonaPlex not available, fall through to fallback pipeline
        console.warn("PersonaPlex unavailable, falling back to STT+LLM+TTS");
      } else {
        const s2sStart = Date.now();
        const s2sResult = await processWithPersonaPlex(
          audioBuffer,
          selected.config,
          selected.transport,
        );
        const s2sMs = Date.now() - s2sStart;

        if (s2sResult.success && s2sResult.audioBuffer) {
          const transcript = pickTextForRouting(s2sResult.transcription);
          const responseText = pickTextForRouting(s2sResult.response);
          const handoffToken =
            hasHandoffToken(s2sResult.response) || hasHandoffToken(s2sResult.transcription);
          const routingText = transcript || responseText;

          if (routingText) {
            const sensitive = detectSensitiveData(routingText);
            const offline = await isOffline();
            const complexity = analyzeComplexity(routingText);
            const complex = complexity.score >= config.router.complexityThreshold;

            if (!offline && !sensitive.detected && (handoffToken || complex)) {
              const thinking = complex ? "xhigh" : "medium";
              const reason = complex ? "personaplex_complexity" : "personaplex_handoff";
              return await runFallbackPipeline({
                audioBuffer,
                config,
                llmInvoke,
                sessionId,
                startTime,
                overrides: {
                  model: config.router.cloudModel,
                  thinking,
                  reason,
                  complexityScore: complexity.score,
                  sensitiveDetected: sensitive.detected,
                },
              });
            }
          }

          // PersonaPlex succeeded - return native S2S result
          return {
            success: true,
            sessionId,
            transcription: s2sResult.transcription,
            response: s2sResult.response,
            audioPath: s2sResult.audioPath,
            audioBuffer: s2sResult.audioBuffer,
            timings: {
              totalMs: s2sMs,
              // S2S doesn't have separate STT/LLM/TTS timings
            },
          };
        }

        // PersonaPlex failed - log and fall through to fallback
        console.warn(`PersonaPlex S2S failed: ${s2sResult.error}, falling back to STT+LLM+TTS`);
      }
    }
  }

  // FALLBACK PATH: STT → LLM → TTS (when PersonaPlex unavailable or failed)
  return runFallbackPipeline({
    audioBuffer,
    config,
    llmInvoke,
    sessionId,
    startTime,
  });
}

/**
 * Process text input (skip STT) through routing, LLM, and TTS.
 * Useful for testing or hybrid interactions.
 * Respects ttsProvider setting for output synthesis.
 */
export async function processTextToVoice(
  text: string,
  config: ResolvedVoiceConfig,
  llmInvoke: (text: string, model?: string, thinking?: string) => Promise<string>,
): Promise<VoiceProcessResult> {
  const sessionId = generateSessionId();
  const startTime = Date.now();
  return runFallbackPipeline({
    transcription: text,
    config,
    llmInvoke,
    sessionId,
    startTime,
  });
}
