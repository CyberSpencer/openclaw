/**
 * Voice mode controller for the web UI.
 *
 * Implements a natural conversational voice interface with Voice Activity Detection (VAD).
 * Click once to start a conversation, speak naturally, and click again to end.
 * VAD automatically detects when you stop speaking to trigger processing.
 */

import type { GatewayBrowserClient } from "../gateway.ts";
import { normalizeTextForDisplay, normalizeTextForTts } from "../text-normalization.ts";
import { buildWorkletModuleUrl, supportsAudioWorkletRuntime } from "../worklets.ts";
import { pcmFramesToWavBlob } from "./audio-capture.ts";

// VAD Configuration
const VAD_SILENCE_THRESHOLD = 15; // Audio level below this = silence (0-255)
const VAD_SPEECH_THRESHOLD = 25; // Audio level above this = speech detected
const VAD_SILENCE_DURATION_MS = 750; // How long silence before triggering processing (0.75s)
const VAD_MIN_SPEECH_MS = 300; // Minimum speech duration to be valid
const VAD_CALIBRATION_MS = 350; // Ambient sampling window before full VAD decisions

// Barge-in tuning while assistant is speaking
const BARGE_IN_SPEECH_THRESHOLD = 30;
const BARGE_IN_MIN_SPEECH_MS = 220;

const WORKLET_VERSION = "20260210-v1";

export type ConversationPhase = "idle" | "listening" | "processing" | "speaking";

export type VoiceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enabled: boolean;
  mode: "option2a" | "spark";
  sparkVoiceAvailable: boolean;
  sessionKey: string | null;
  driveOpenClaw: boolean;

  // Conversation state
  conversationActive: boolean;
  phase: ConversationPhase;

  // VAD state
  speechDetected: boolean;
  silenceStart: number | null;
  speechStart: number | null;
  currentAudioLevel: number;
  ambientAudioLevel: number | null;
  vadSpeechThreshold: number;
  vadSilenceThreshold: number;
  vadSilenceDurationMs: number;

  // Recording/VAD components
  audioContext: AudioContext | null;
  mediaRecorder: MediaRecorder | null;
  mediaStream: MediaStream | null;
  analyserNode: AnalyserNode | null;
  vadLoop: number | null;
  audioChunks: Blob[];

  // Low-latency worklet capture path (conversation mode)
  captureWorkletContext: AudioContext | null;
  captureWorkletNode: AudioWorkletNode | null;
  capturePcmFrames: Int16Array[];
  captureUsingWorklet: boolean;
  captureWorkletDisabledForSession: boolean;

  // Playback components (AII-style worklet-ready)
  playbackContext: AudioContext | null;
  playbackWorklet: AudioWorkletNode | null;
  playbackSeq: number;
  playbackAbort: AbortController | null;
  playbackHtmlAudio: HTMLAudioElement | null;

  // Barge-in monitor while assistant is speaking
  interruptAudioContext: AudioContext | null;
  interruptStream: MediaStream | null;
  interruptAnalyser: AnalyserNode | null;
  interruptLoop: number | null;

  // Results
  transcription: string | null;
  response: string | null;
  error: string | null;
  capabilities: VoiceCapabilities | null;
  timings: VoiceTimings | null;

  // Optional TTS steering (voice = who, instruct = mood/style, language = hint)
  ttsVoice: string | null;
  ttsInstruct: string | null;
  ttsLanguage: string | null;
};

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

export type VoiceTimings = {
  sttMs?: number;
  routingMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs: number;
};

export type VoiceStatusResult = {
  enabled: boolean;
  mode: string;
  sttProvider: string;
  ttsProvider: string;
  capabilities: VoiceCapabilities;
  streaming: boolean;
};

export type VoiceProcessResult = {
  sessionId: string;
  transcription?: string;
  response?: string;
  audioBase64?: string;
  audioFormat?: string;
  route?: string;
  model?: string;
  thinkingLevel?: string;
  runId?: string;
  timings?: VoiceTimings;
};

export type VoiceSynthesizeResult = {
  audioBase64?: string;
  audioPath?: string;
  provider: string;
  latencyMs?: number;
  warning?: string;
};

export function deriveVadProfile(ambientLevel: number): {
  speechThreshold: number;
  silenceThreshold: number;
  silenceDurationMs: number;
} {
  const normalizedAmbient = Math.max(0, Math.min(60, ambientLevel));
  const speechThreshold = Math.max(VAD_SPEECH_THRESHOLD, Math.round(normalizedAmbient + 10));
  const silenceThreshold = Math.max(
    VAD_SILENCE_THRESHOLD,
    Math.min(speechThreshold - 3, Math.round(normalizedAmbient + 2)),
  );
  const silenceDurationMs = Math.max(
    550,
    Math.min(1400, Math.round(VAD_SILENCE_DURATION_MS + normalizedAmbient * 8)),
  );
  return {
    speechThreshold,
    silenceThreshold,
    silenceDurationMs,
  };
}

/**
 * Create initial voice state.
 */
export function createVoiceState(): VoiceState {
  return {
    client: null,
    connected: false,
    enabled: false,
    mode: "spark", // Default to Spark STT/TTS (PersonaPlex disabled)
    sparkVoiceAvailable: false,
    sessionKey: null,
    driveOpenClaw: true,

    // Conversation state
    conversationActive: false,
    phase: "idle",

    // VAD state
    speechDetected: false,
    silenceStart: null,
    speechStart: null,
    currentAudioLevel: 0,
    ambientAudioLevel: null,
    vadSpeechThreshold: VAD_SPEECH_THRESHOLD,
    vadSilenceThreshold: VAD_SILENCE_THRESHOLD,
    vadSilenceDurationMs: VAD_SILENCE_DURATION_MS,

    // Recording/VAD components
    audioContext: null,
    mediaRecorder: null,
    mediaStream: null,
    analyserNode: null,
    vadLoop: null,
    audioChunks: [],

    // Low-latency worklet capture path
    captureWorkletContext: null,
    captureWorkletNode: null,
    capturePcmFrames: [],
    captureUsingWorklet: false,
    captureWorkletDisabledForSession: false,

    // Playback components
    playbackContext: null,
    playbackWorklet: null,
    playbackSeq: 1,
    playbackAbort: null,
    playbackHtmlAudio: null,

    // Barge-in monitor
    interruptAudioContext: null,
    interruptStream: null,
    interruptAnalyser: null,
    interruptLoop: null,

    // Results
    transcription: null,
    response: null,
    error: null,
    capabilities: null,
    timings: null,

    // TTS steering (synced from app when starting conversation)
    ttsVoice: null,
    ttsInstruct: null,
    ttsLanguage: null,
  };
}

/**
 * Load voice status from gateway.
 */
export async function loadVoiceStatus(state: VoiceState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }

  try {
    const result = await state.client.request("voice.status", {});

    state.enabled = result.enabled;
    const mode = result.mode;
    state.mode = mode === "spark" ? "spark" : "option2a";
    state.capabilities = result.capabilities;
    state.error = null;
  } catch (err) {
    state.error = String(err);
  }
}

function supportsAudioWorklet(): boolean {
  return supportsAudioWorkletRuntime();
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const audioData = atob(base64);
  const arrayBuffer = new ArrayBuffer(audioData.length);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < audioData.length; i++) {
    view[i] = audioData.charCodeAt(i);
  }
  return arrayBuffer;
}

async function ensurePlaybackWorklet(state: VoiceState): Promise<boolean> {
  if (!supportsAudioWorklet()) {
    return false;
  }

  if (state.playbackContext && state.playbackWorklet) {
    return true;
  }

  let playbackContext: AudioContext | null = null;
  try {
    playbackContext = new AudioContext({ sampleRate: 24000 });
    if (playbackContext.state === "suspended") {
      await playbackContext.resume().catch(() => undefined);
    }

    await playbackContext.audioWorklet.addModule(
      buildWorkletModuleUrl("playback-processor.js", WORKLET_VERSION),
    );

    const playbackWorklet = new AudioWorkletNode(playbackContext, "playback-processor");
    playbackWorklet.connect(playbackContext.destination);

    state.playbackContext = playbackContext;
    state.playbackWorklet = playbackWorklet;
    state.playbackSeq = 1;
    return true;
  } catch (err) {
    console.warn("[Voice] Playback worklet unavailable, falling back to <audio>", err);
    try {
      await playbackContext?.close();
    } catch {
      // ignore
    }
    return false;
  }
}

function stopPlayback(state: VoiceState): void {
  if (state.playbackAbort) {
    state.playbackAbort.abort();
    state.playbackAbort = null;
  }

  if (state.playbackHtmlAudio) {
    try {
      state.playbackHtmlAudio.pause();
      state.playbackHtmlAudio.currentTime = 0;
    } catch {
      // ignore
    }
    state.playbackHtmlAudio = null;
  }

  if (state.playbackWorklet) {
    try {
      state.playbackWorklet.port.postMessage({ type: "clear" });
    } catch {
      // ignore
    }
  }
}

function cleanupInterruptMonitor(state: VoiceState): void {
  if (state.interruptLoop !== null) {
    cancelAnimationFrame(state.interruptLoop);
    state.interruptLoop = null;
  }

  if (state.interruptStream) {
    for (const track of state.interruptStream.getTracks()) {
      track.stop();
    }
    state.interruptStream = null;
  }

  if (state.interruptAudioContext) {
    void state.interruptAudioContext.close().catch(() => undefined);
    state.interruptAudioContext = null;
  }

  state.interruptAnalyser = null;
}

function isLiveMicStream(stream: MediaStream | null): stream is MediaStream {
  if (!stream) {
    return false;
  }
  return stream.getTracks().some((track) => track.readyState !== "ended");
}

export async function ensureConversationMicStream(state: VoiceState): Promise<MediaStream> {
  if (isLiveMicStream(state.mediaStream)) {
    return state.mediaStream;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 16000,
    },
  });
  state.mediaStream = stream;
  return stream;
}

async function startBargeInMonitor(state: VoiceState, onInterrupt: () => void): Promise<void> {
  cleanupInterruptMonitor(state);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);

    state.interruptStream = stream;
    state.interruptAudioContext = ctx;
    state.interruptAnalyser = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let speechStartAt: number | null = null;

    const tick = () => {
      if (!state.conversationActive || state.phase !== "speaking") {
        cleanupInterruptMonitor(state);
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      const now = Date.now();
      if (average > BARGE_IN_SPEECH_THRESHOLD) {
        if (speechStartAt == null) {
          speechStartAt = now;
        } else if (now - speechStartAt >= BARGE_IN_MIN_SPEECH_MS) {
          cleanupInterruptMonitor(state);
          onInterrupt();
          return;
        }
      } else {
        speechStartAt = null;
      }

      state.interruptLoop = requestAnimationFrame(tick);
    };

    state.interruptLoop = requestAnimationFrame(tick);
  } catch {
    // If we can't monitor barge-in (permissions/device), continue normally.
  }
}

/**
 * Setup Voice Activity Detection using Web Audio API.
 * Monitors audio levels to detect speech start/end.
 */
function setupVAD(
  state: VoiceState,
  stream: MediaStream,
  onSpeechEnd: () => void,
  onUpdate: () => void,
): void {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  state.audioContext = audioContext;
  state.analyserNode = analyser;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const calibrationSamples: number[] = [];
  const calibrationStartedAt = Date.now();
  let profileApplied = false;

  function checkAudioLevel() {
    if (!state.conversationActive || state.phase !== "listening") {
      return;
    }

    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    state.currentAudioLevel = average;

    const now = Date.now();
    if (!profileApplied) {
      if (now - calibrationStartedAt < VAD_CALIBRATION_MS) {
        calibrationSamples.push(average);
        state.vadLoop = requestAnimationFrame(checkAudioLevel);
        return;
      }
      const ambient =
        calibrationSamples.length > 0
          ? calibrationSamples.reduce((sum, value) => sum + value, 0) / calibrationSamples.length
          : average;
      const profile = deriveVadProfile(ambient);
      state.ambientAudioLevel = ambient;
      state.vadSpeechThreshold = profile.speechThreshold;
      state.vadSilenceThreshold = profile.silenceThreshold;
      state.vadSilenceDurationMs = profile.silenceDurationMs;
      profileApplied = true;
      onUpdate();
    }

    // Detect speech start
    if (average > state.vadSpeechThreshold) {
      if (!state.speechDetected) {
        state.speechDetected = true;
        state.speechStart = now;
        state.silenceStart = null;
        onUpdate();
      } else {
        // Reset silence timer if speaking again
        state.silenceStart = null;
      }
    }
    // Detect silence after speech
    else if (state.speechDetected && average < state.vadSilenceThreshold) {
      if (!state.silenceStart) {
        state.silenceStart = now;
      } else if (now - state.silenceStart > state.vadSilenceDurationMs) {
        // Check minimum speech duration
        const speechDuration = state.speechStart ? state.silenceStart - state.speechStart : 0;
        if (speechDuration >= VAD_MIN_SPEECH_MS) {
          // Silence detected after valid speech - trigger processing
          onSpeechEnd();
          return;
        } else {
          // Speech too short, reset and keep listening
          state.speechDetected = false;
          state.silenceStart = null;
          state.speechStart = null;
        }
      }
    }

    state.vadLoop = requestAnimationFrame(checkAudioLevel);
  }

  checkAudioLevel();
}

/**
 * Stop VAD monitoring.
 */
function stopVAD(state: VoiceState): void {
  if (state.vadLoop !== null) {
    cancelAnimationFrame(state.vadLoop);
    state.vadLoop = null;
  }
  state.analyserNode = null;
}

async function startConversationWorkletCapture(
  state: VoiceState,
  stream: MediaStream,
): Promise<boolean> {
  if (!supportsAudioWorklet() || state.captureWorkletDisabledForSession) {
    return false;
  }

  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;

  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => undefined);
    }

    await ctx.audioWorklet.addModule(
      buildWorkletModuleUrl("capture-processor.js", WORKLET_VERSION),
    );

    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "capture-processor", {
      processorOptions: {
        targetSampleRate: 16000,
        frameSize: 480,
      },
    });

    state.capturePcmFrames = [];
    node.port.addEventListener("message", (event) => {
      if (event.data?.type === "audio" && event.data?.pcm16) {
        state.capturePcmFrames.push(event.data.pcm16 as Int16Array);
      }
    });
    node.port.start();
    source.connect(node);

    state.captureWorkletContext = ctx;
    state.captureWorkletNode = node;
    state.captureUsingWorklet = true;
    return true;
  } catch (err) {
    console.warn("[Voice] Worklet capture unavailable, falling back to MediaRecorder", err);
    state.captureWorkletDisabledForSession = true;
    state.captureUsingWorklet = false;
    state.capturePcmFrames = [];
    try {
      source?.disconnect();
    } catch {
      // ignore
    }
    try {
      node?.disconnect();
    } catch {
      // ignore
    }
    try {
      await ctx?.close();
    } catch {
      // ignore
    }
    return false;
  }
}

async function stopConversationWorkletCapture(state: VoiceState): Promise<Blob | null> {
  if (!state.captureUsingWorklet) {
    return null;
  }

  const frames = state.capturePcmFrames;
  state.capturePcmFrames = [];
  state.captureUsingWorklet = false;

  const node = state.captureWorkletNode;
  const ctx = state.captureWorkletContext;
  state.captureWorkletNode = null;
  state.captureWorkletContext = null;

  try {
    node?.disconnect();
  } catch {
    // ignore
  }
  try {
    await ctx?.close();
  } catch {
    // ignore
  }

  if (!frames.length) {
    return null;
  }

  const { blob } = pcmFramesToWavBlob(frames, 16000);
  return blob;
}

/**
 * Start recording with VAD.
 */
async function startRecordingWithVAD(
  state: VoiceState,
  onSpeechEnd: () => void,
  onUpdate: () => void,
): Promise<boolean> {
  try {
    // Ensure stale resources from previous turns are released.
    cleanupInterruptMonitor(state);
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
    if (state.audioContext) {
      void state.audioContext.close().catch(() => undefined);
      state.audioContext = null;
    }

    // Reuse a live conversation mic stream when available to reduce per-turn startup latency.
    const stream = await ensureConversationMicStream(state);

    // Setup VAD monitoring
    setupVAD(state, stream, onSpeechEnd, onUpdate);

    state.captureUsingWorklet = false;
    state.capturePcmFrames = [];

    // Prefer low-latency worklet capture when available.
    const usingWorklet = await startConversationWorkletCapture(state, stream);
    if (!usingWorklet) {
      // Fallback to MediaRecorder capture.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      state.mediaRecorder = new MediaRecorder(stream, { mimeType });
      state.audioChunks = [];

      state.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          state.audioChunks.push(event.data);
        }
      };

      state.mediaRecorder.start(100);
    }

    state.phase = "listening";
    state.speechDetected = false;
    state.silenceStart = null;
    state.speechStart = null;
    state.ambientAudioLevel = null;
    state.vadSpeechThreshold = VAD_SPEECH_THRESHOLD;
    state.vadSilenceThreshold = VAD_SILENCE_THRESHOLD;
    state.vadSilenceDurationMs = VAD_SILENCE_DURATION_MS;
    state.error = null;

    return true;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
    state.error = `Microphone access denied: ${message}`;
    return false;
  }
}

/**
 * Stop recording and get audio blob.
 */
function stopRecordingGetAudio(state: VoiceState): Promise<Blob | null> {
  return new Promise((resolve) => {
    stopVAD(state);

    const finalize = (blob: Blob | null) => {
      const keepStreamHot = state.conversationActive;
      if (!keepStreamHot && state.mediaStream) {
        for (const track of state.mediaStream.getTracks()) {
          track.stop();
        }
        state.mediaStream = null;
      }
      if (state.audioContext) {
        void state.audioContext.close().catch(() => undefined);
        state.audioContext = null;
      }
      state.mediaRecorder = null;
      resolve(blob);
    };

    if (state.captureUsingWorklet) {
      void stopConversationWorkletCapture(state).then((blob) => {
        finalize(blob);
      });
      return;
    }

    if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") {
      finalize(
        state.audioChunks.length > 0 ? new Blob(state.audioChunks, { type: "audio/webm" }) : null,
      );
      return;
    }

    const mime = state.mediaRecorder.mimeType;
    state.mediaRecorder.onstop = () => {
      const blob =
        state.audioChunks.length > 0 ? new Blob(state.audioChunks, { type: mime }) : null;
      finalize(blob);
    };

    state.mediaRecorder.stop();
  });
}

/**
 * Cleanup all audio resources.
 */
function cleanupAudio(state: VoiceState): void {
  stopVAD(state);
  stopPlayback(state);
  cleanupInterruptMonitor(state);

  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  state.mediaRecorder = null;

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }

  if (state.audioContext) {
    void state.audioContext.close().catch(() => undefined);
    state.audioContext = null;
  }

  if (state.captureWorkletNode) {
    try {
      state.captureWorkletNode.disconnect();
    } catch {
      // ignore
    }
    state.captureWorkletNode = null;
  }
  if (state.captureWorkletContext) {
    void state.captureWorkletContext.close().catch(() => undefined);
    state.captureWorkletContext = null;
  }
  state.capturePcmFrames = [];
  state.captureUsingWorklet = false;

  if (state.playbackWorklet) {
    try {
      state.playbackWorklet.disconnect();
    } catch {
      // ignore
    }
    state.playbackWorklet = null;
  }

  if (state.playbackContext) {
    void state.playbackContext.close().catch(() => undefined);
    state.playbackContext = null;
  }

  state.playbackAbort = null;
  state.playbackHtmlAudio = null;
  state.playbackSeq = 1;

  state.audioChunks = [];
  state.speechDetected = false;
  state.silenceStart = null;
  state.speechStart = null;
  state.ambientAudioLevel = null;
  state.vadSpeechThreshold = VAD_SPEECH_THRESHOLD;
  state.vadSilenceThreshold = VAD_SILENCE_THRESHOLD;
  state.vadSilenceDurationMs = VAD_SILENCE_DURATION_MS;
}

/**
 * Convert audio blob to base64.
 */
export async function audioToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Extract base64 part from data URL
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("FileReader error"));
    });
    reader.readAsDataURL(blob);
  });
}

/**
 * Process voice input through full pipeline.
 */
export async function processVoiceInput(
  state: VoiceState,
  audioBase64: string,
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    console.error("[Voice] Not connected to gateway");
    return null;
  }

  state.error = null;
  state.transcription = null;
  state.response = null;
  state.timings = null;

  try {
    console.log("[Voice] Sending audio to gateway for processing...");
    const request: Record<string, unknown> = {
      audio: audioBase64,
      driveOpenClaw: state.driveOpenClaw,
    };
    if (state.sessionKey) {
      request.sessionKey = state.sessionKey;
    }
    const result = await state.client.request("voice.process", {
      ...request,
    });

    console.log("[Voice] Got response:", {
      hasAudio: !!result.audioBase64,
      audioLength: result.audioBase64?.length ?? 0,
      transcription: result.transcription,
    });

    state.transcription =
      typeof result.transcription === "string"
        ? normalizeTextForDisplay(result.transcription)
        : null;
    state.response =
      typeof result.response === "string" ? normalizeTextForDisplay(result.response) : null;
    state.timings = result.timings ?? null;

    return result;
  } catch (err) {
    console.error("[Voice] Processing error:", err);
    state.error = String(err);
    return null;
  }
}

/**
 * Process voice input via Spark STT + OpenClaw reply generation + Spark TTS.
 *
 * This is the main conversational path for mode="spark":
 * 1) spark.voice.stt
 * 2) voice.processText (skipTts=true) to get assistant text
 * 3) spark.voice.tts for spoken reply
 */
export async function processVoiceInputSpark(
  state: VoiceState,
  audioBase64: string,
  format = "webm",
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    console.error("[Voice/Spark] Not connected to gateway");
    return null;
  }

  state.error = null;
  state.transcription = null;
  state.response = null;
  state.timings = null;

  try {
    const startedAt = Date.now();

    // 1) STT
    console.log("[Voice/Spark] Sending audio to spark.voice.stt...");
    const sttStart = Date.now();
    const sttResult = await state.client.request("spark.voice.stt", {
      audio_base64: audioBase64,
      format,
    });
    const sttMs = Date.now() - sttStart;

    const text = (sttResult as Record<string, unknown>)?.text ?? "";
    state.transcription = typeof text === "string" ? normalizeTextForDisplay(text) : "";

    console.log("[Voice/Spark] STT result:", { text: state.transcription, sttMs });

    if (!state.transcription.trim()) {
      state.error = "No speech detected";
      state.timings = { sttMs, totalMs: Date.now() - startedAt };
      return {
        sessionId: "",
        transcription: state.transcription,
        response: "",
        timings: state.timings,
      };
    }

    // 2) Generate assistant reply text via normal OpenClaw chat pipeline (no local TTS)
    const llmStart = Date.now();
    const reply = await state.client.request("voice.processText", {
      text: state.transcription,
      sessionKey: state.sessionKey ?? undefined,
      driveOpenClaw: state.driveOpenClaw,
      skipTts: true,
    });
    const llmMs = Date.now() - llmStart;

    const responseTextRaw = (reply as Record<string, unknown>)?.response;
    const responseText =
      typeof responseTextRaw === "string" ? normalizeTextForDisplay(responseTextRaw) : "";
    state.response = responseText;

    const baseResult: VoiceProcessResult = {
      sessionId:
        typeof (reply as Record<string, unknown>)?.sessionId === "string"
          ? ((reply as Record<string, unknown>).sessionId as string)
          : "",
      transcription: state.transcription,
      response: responseText,
      route:
        typeof (reply as Record<string, unknown>)?.route === "string"
          ? ((reply as Record<string, unknown>).route as string)
          : undefined,
      model:
        typeof (reply as Record<string, unknown>)?.model === "string"
          ? ((reply as Record<string, unknown>).model as string)
          : undefined,
      thinkingLevel:
        typeof (reply as Record<string, unknown>)?.thinkingLevel === "string"
          ? ((reply as Record<string, unknown>).thinkingLevel as string)
          : undefined,
      runId:
        typeof (reply as Record<string, unknown>)?.runId === "string"
          ? ((reply as Record<string, unknown>).runId as string)
          : undefined,
    };

    if (!responseText.trim()) {
      state.timings = {
        sttMs,
        llmMs,
        totalMs: Date.now() - startedAt,
      };
      return {
        ...baseResult,
        timings: state.timings,
      };
    }

    // 3) TTS via Spark
    const ttsInput = normalizeTextForTts(responseText);
    if (!ttsInput) {
      state.timings = {
        sttMs,
        llmMs,
        totalMs: Date.now() - startedAt,
      };
      return {
        ...baseResult,
        timings: state.timings,
      };
    }

    const ttsStart = Date.now();
    let ttsResult: Record<string, unknown> | null = null;
    const ttsParams: Record<string, string> = { text: ttsInput, format: "webm" };
    if (state.ttsVoice != null && state.ttsVoice.trim() !== "") {
      ttsParams.voice = state.ttsVoice.trim();
    }
    if (state.ttsInstruct != null && state.ttsInstruct.trim() !== "") {
      ttsParams.instruct = state.ttsInstruct.trim();
    }
    if (state.ttsLanguage != null && state.ttsLanguage.trim() !== "") {
      ttsParams.language = state.ttsLanguage.trim();
    }
    try {
      ttsResult = await state.client.request("spark.voice.tts", ttsParams);
    } catch (ttsErr) {
      console.error("[Voice/Spark] TTS error:", ttsErr);
      state.error = `TTS failed: ${ttsErr instanceof Error ? ttsErr.message : String(ttsErr)}`;
    }
    const ttsMs = Date.now() - ttsStart;

    const audio = ttsResult?.audio_base64;
    const fmt = ttsResult?.format;

    state.timings = {
      sttMs,
      llmMs,
      ttsMs,
      totalMs: Date.now() - startedAt,
    };

    return {
      ...baseResult,
      audioBase64: typeof audio === "string" ? audio : undefined,
      audioFormat: typeof fmt === "string" ? fmt : "webm",
      timings: state.timings,
    };
  } catch (err) {
    console.error("[Voice/Spark] Pipeline error:", err);
    state.error = String(err);
    return null;
  }
}

/**
 * Process text through voice pipeline (skip STT).
 */
export async function processTextToVoice(
  state: VoiceState,
  text: string,
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }

  state.error = null;
  state.transcription = normalizeTextForDisplay(text);
  state.response = null;
  state.timings = null;

  try {
    const result = await state.client.request("voice.processText", {
      text,
      sessionKey: state.sessionKey ?? undefined,
      driveOpenClaw: state.driveOpenClaw,
    });

    state.response =
      typeof result.response === "string" ? normalizeTextForDisplay(result.response) : null;
    state.timings = result.timings ?? null;

    return result;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Transcribe audio only (no LLM/TTS).
 */
export async function transcribeAudio(
  state: VoiceState,
  audioBase64: string,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }

  try {
    const result = await state.client.request("voice.transcribe", {
      audio: audioBase64,
    });

    return typeof result.text === "string" ? normalizeTextForDisplay(result.text) : null;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Synthesize speech from text.
 */
export async function synthesizeSpeech(
  state: VoiceState,
  text: string,
): Promise<VoiceSynthesizeResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }

  try {
    const result = await state.client.request("voice.synthesize", {
      text,
    });

    return result;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Play audio from base64.
 * Returns a promise that resolves when playback completes.
 *
 * For webm/mp3 we use HTMLAudioElement (better codec support).
 * For wav/unknown we try WebAudio decode first, then fall back to HTMLAudioElement.
 */
export async function playAudioBase64(
  base64: string,
  state?: VoiceState,
  format?: string,
): Promise<void> {
  console.log("[Voice] Playing audio", { length: base64.length, format });

  const fmt = (format ?? "").trim().toLowerCase();
  const mime = fmt === "webm" ? "audio/webm" : fmt ? `audio/${fmt}` : "audio/wav";

  if (state) {
    state.phase = "speaking";
    stopPlayback(state);
    state.playbackAbort = new AbortController();
  }

  const signal = state?.playbackAbort?.signal ?? null;

  const playViaAudioElement = async () => {
    const audio = new Audio(`data:${mime};base64,${base64}`);
    if (state) {
      state.playbackHtmlAudio = audio;
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };

      const onEnded = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error("Audio playback failed"));
      };

      const onAbort = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // ignore
        }
        cleanup();
        resolve();
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      signal?.addEventListener("abort", onAbort);

      audio.play().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  };

  const tryPlayViaWorklet = async (): Promise<boolean> => {
    if (!state) {
      return false;
    }

    const ready = await ensurePlaybackWorklet(state);
    if (!ready || !state.playbackContext || !state.playbackWorklet) {
      return false;
    }

    try {
      const arrayBuffer = decodeBase64ToArrayBuffer(base64);
      const decoded = await state.playbackContext.decodeAudioData(arrayBuffer.slice(0));

      const mono = decoded.getChannelData(0);
      const frameSize = 960; // 40ms @ 24kHz
      const worklet = state.playbackWorklet;

      await new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent<{ type?: string }>) => {
          if (event.data?.type === "playback_complete") {
            cleanup();
            resolve();
          }
        };

        const onAbort = () => {
          try {
            worklet.port.postMessage({ type: "clear" });
          } catch {
            // ignore
          }
          cleanup();
          resolve();
        };

        const cleanup = () => {
          worklet.port.removeEventListener("message", onMessage as EventListener);
          signal?.removeEventListener("abort", onAbort);
        };

        worklet.port.start();
        worklet.port.addEventListener("message", onMessage as EventListener);
        signal?.addEventListener("abort", onAbort);

        for (let i = 0; i < mono.length; i += frameSize) {
          if (signal?.aborted) {
            onAbort();
            return;
          }
          const chunk = mono.slice(i, Math.min(i + frameSize, mono.length));
          worklet.port.postMessage({
            type: "audio",
            data: chunk,
            seq: state.playbackSeq++,
          });
        }

        worklet.port.postMessage({ type: "server_audio_complete" });
      });

      return true;
    } catch (err) {
      console.warn("[Voice] Worklet playback decode failed", err);
      return false;
    }
  };

  try {
    const playedWithWorklet = await tryPlayViaWorklet();
    if (!playedWithWorklet) {
      await playViaAudioElement();
    }
  } catch (err) {
    // Final fallback for browser codec/decode edge cases.
    console.warn("[Voice] Playback failed, final fallback to <audio>", err);
    await playViaAudioElement();
  } finally {
    if (state) {
      state.playbackHtmlAudio = null;
      state.playbackAbort = null;
    }
  }
}

/**
 * Start a natural conversational voice session.
 *
 * Flow:
 * 1. Click to start → mic goes live, listening begins
 * 2. Speak → VAD detects speech
 * 3. Stop speaking → VAD detects silence → auto-process
 * 4. AI responds with audio → auto-play
 * 5. After response → auto-listen again
 * 6. Click to stop → conversation ends
 */
export async function startConversation(
  state: VoiceState,
  onUpdate: () => void,
  onProcess: (input: { audioBase64: string; format: string }) => Promise<VoiceProcessResult | null>,
): Promise<void> {
  if (state.conversationActive) {
    return;
  }
  if (state.mode === "spark" && !state.sparkVoiceAvailable) {
    state.error = "Spark voice is unavailable. Check DGX voice health and try again.";
    state.phase = "idle";
    onUpdate();
    return;
  }

  console.log("[Voice] Starting conversation...");
  state.conversationActive = true;
  state.phase = "listening";
  state.error = null;
  state.transcription = null;
  state.response = null;
  onUpdate();

  // Conversation loop - continues until user clicks stop
  while (state.conversationActive && state.connected && state.enabled) {
    try {
      console.log("[Voice] Starting new turn, phase: listening");

      // Promise that resolves when VAD detects end of speech
      let speechEndResolve: () => void;
      const speechEndPromise = new Promise<void>((resolve) => {
        speechEndResolve = resolve;
      });

      // Start recording with VAD
      const recordSuccess = await startRecordingWithVAD(
        state,
        () => {
          console.log("[Voice] VAD detected silence after speech");
          speechEndResolve();
        },
        onUpdate,
      );

      if (!recordSuccess) {
        console.error("[Voice] Failed to start recording");
        state.error = "Failed to start recording";
        break;
      }
      console.log("[Voice] Recording started, waiting for speech...");
      onUpdate();

      // Wait for VAD to detect end of speech (or conversation to be stopped)
      await Promise.race([speechEndPromise, waitForConversationEnd(state)]);

      // If conversation was stopped, exit
      if (!state.conversationActive) {
        console.log("[Voice] Conversation stopped by user");
        break;
      }

      // Stop recording and get audio
      console.log("[Voice] Getting recorded audio...");
      state.phase = "processing";
      onUpdate();

      const audioBlob = await stopRecordingGetAudio(state);
      console.log("[Voice] Audio blob size:", audioBlob?.size ?? 0);

      if (!audioBlob || audioBlob.size === 0) {
        console.log("[Voice] No audio recorded, restarting listening");
        state.phase = "listening";
        state.speechDetected = false;
        continue;
      }

      // Process the audio through PersonaPlex S2S
      console.log("[Voice] Processing audio...");
      const base64 = await audioToBase64(audioBlob);
      state.audioChunks = [];
      const format = audioBlob.type.toLowerCase().includes("wav") ? "wav" : "webm";

      const result = await onProcess({ audioBase64: base64, format });
      console.log("[Voice] Process result:", {
        hasResult: !!result,
        hasAudio: !!result?.audioBase64,
        error: state.error,
      });
      onUpdate();

      // If conversation was stopped during processing, exit
      if (!state.conversationActive) {
        break;
      }

      // Play the response (with barge-in monitor)
      let interrupted = false;
      if (result?.audioBase64) {
        console.log("[Voice] Playing audio response...");
        state.phase = "speaking";
        onUpdate();

        await startBargeInMonitor(state, () => {
          interrupted = true;
          console.log("[Voice] Barge-in detected, interrupting playback");
          stopPlayback(state);
        });

        await playAudioBase64(result.audioBase64, state, result.audioFormat);
        cleanupInterruptMonitor(state);
        onUpdate();
      }

      // If user stopped conversation or we interrupted playback, transition quickly.
      if (!state.conversationActive) {
        break;
      }

      if (!interrupted) {
        // Brief pause before next listening cycle
        await new Promise((r) => setTimeout(r, 300));
      }

      // Reset for next turn
      state.phase = "listening";
      state.speechDetected = false;
      state.silenceStart = null;
      state.speechStart = null;
      onUpdate();
    } catch (err) {
      stopPlayback(state);
      cleanupInterruptMonitor(state);
      state.error = String(err);
      onUpdate();
      // Try to continue conversation despite error
      state.phase = "listening";
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Cleanup
  cleanupAudio(state);
  state.conversationActive = false;
  state.phase = "idle";
  onUpdate();
}

/**
 * Wait for conversation to end (user clicks stop).
 */
async function waitForConversationEnd(state: VoiceState): Promise<void> {
  while (state.conversationActive) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Stop the conversation completely.
 * Called when user clicks the stop button.
 */
export function stopConversation(state: VoiceState): void {
  state.conversationActive = false;
  cleanupAudio(state);
  state.phase = "idle";
}

/**
 * Check if browser supports voice features.
 */
export function checkBrowserSupport(): {
  supported: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!navigator.mediaDevices?.getUserMedia) {
    issues.push("Microphone API not supported");
  }

  if (!window.MediaRecorder) {
    issues.push("MediaRecorder not supported");
  }

  if (!window.AudioContext) {
    issues.push("AudioContext not supported");
  }

  return {
    supported: issues.length === 0,
    issues,
  };
}
