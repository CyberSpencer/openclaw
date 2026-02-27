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
const SPARK_STT_TIMEOUT_MS = 10_000;
const SPARK_LLM_TIMEOUT_MS = 120_000;
const SPARK_LLM_PROVISIONAL_TIMEOUT_MS = 6_000;
const SPARK_TTS_TIMEOUT_MS = 60_000;
const VOICE_RECONCILE_STALE_MS = 15_000;
const BACKCHANNEL_BEEP_DURATION_MS = 140;
const SHORT_TURN_MAX_SPEECH_MS = 6_000;
const SHORT_TURN_MAX_OUTPUT_TOKENS = 120;
const PROVISIONAL_MAX_OUTPUT_TOKENS = 64;
const VOICE_SLO_SAMPLE_LIMIT = 120;
const ACTION_TURN_PREFIX_REGEX =
  /^\s*(please\s+)?(run|execute|send|email|message|post|publish|deploy|delete|remove|write|edit|update|create|install|commit|push|merge|approve|deny)\b/i;
const ACTION_TURN_KEYWORD_REGEX =
  /\b(send|email|message|post|publish|deploy|delete|remove|write|edit|update|create|install|commit|push|merge|approve|deny|chmod|chown|sudo|curl|wget|http request|network call|tool)\b/i;

export type ConversationPhase =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "paused_text_run"
  | "approval_wait"
  | "error";

export type VoiceInterruptedBy =
  | "text_send"
  | "barge_in"
  | "approval_wait"
  | "spark_unavailable"
  | "user_stop";

export type VoicePhaseTransitionMeta = {
  turnId: string | null;
  phase: ConversationPhase;
  interruptedBy: VoiceInterruptedBy | null;
  resumedAt: number | null;
  ts: number;
  seq: number;
};

export type VoiceTranscriptReconcileEntry = {
  clientMessageId: string;
  conversationId: string;
  turnId: string;
  optimisticMessageId: string;
  confirmedMessageId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  status: "optimistic" | "confirmed" | "stale";
};

export type VoiceSparkStreamEventName =
  | "spark.voice.stream.started"
  | "spark.voice.stream.chunk"
  | "spark.voice.stream.completed"
  | "spark.voice.stream.error";

type SparkTtsStreamChunk = {
  seq: number;
  audioBase64: string;
  audioFormat: string;
  sampleRate?: number;
  isLast?: boolean;
  chunkDurationMs?: number;
};

type SparkTtsStreamPending = {
  chunks: SparkTtsStreamChunk[];
  seenSeq: Set<number>;
  expectedTotalChunks: number | null;
  resolve: (chunks: SparkTtsStreamChunk[]) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
};

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
  turnAbortController: AbortController | null;
  conversationId: string | null;
  conversationSessionKey: string | null;
  currentTurnId: string | null;
  currentClientMessageId: string | null;
  transitionMeta: VoicePhaseTransitionMeta | null;
  phaseSeq: number;
  manualStopVersion: number;
  pausedTextRun: {
    conversationId: string;
    sessionKey: string;
    manualStopVersion: number;
    interruptedBy: "text_send" | "approval_wait";
  } | null;
  completedTurnIds: Set<string>;
  transcriptReconcileByClientMessageId: Map<string, VoiceTranscriptReconcileEntry>;
  statusText: string | null;
  firstStatusTextAtMs: number | null;
  firstAudibleAtMs: number | null;
  firstSemanticTextAtMs: number | null;
  semanticSpokenStartAtMs: number | null;
  shortTurnSloSamples: VoiceShortTurnSloSample[];
  shortTurnSloReport: VoiceShortTurnSloReport | null;
  sparkTtsStreamSupport: "unknown" | "supported" | "unsupported";
  sparkTtsStreams: Map<string, SparkTtsStreamPending>;

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
  captureWorkletSource: MediaStreamAudioSourceNode | null;
  captureWorkletNode: AudioWorkletNode | null;
  captureWorkletSink: GainNode | null;
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
  lastRoute: string | null;
  lastModel: string | null;
  lastThinkingLevel: string | null;
  routeModelWarning: string | null;

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
  micStartMs?: number;
  firstSpeechMs?: number;
  sttMs?: number;
  routingMs?: number;
  llmMs?: number;
  llmFirstSemanticMs?: number;
  llmFullCompletionMs?: number;
  ttsMs?: number;
  totalMs: number;
};

export type VoiceShortTurnSloMetric = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
};

export type VoiceShortTurnSloReport = {
  generatedAtMs: number;
  totalTurnCount: number;
  shortTurnCount: number;
  shortTurnSpeechMaxMs: number;
  shortTurnOutputTokenMax: number;
  metrics: {
    eosToFirstAssistantStatusText: VoiceShortTurnSloMetric;
    eosToFirstAudibleByte: VoiceShortTurnSloMetric;
    eosToFirstSemanticAssistantText: VoiceShortTurnSloMetric;
    eosToSemanticSpokenAnswerStart: VoiceShortTurnSloMetric;
  };
};

type VoiceShortTurnSloSample = {
  turnId: string;
  capturedAtMs: number;
  eosAtMs: number;
  speechDurationMs: number | null;
  outputTokenEstimate: number;
  qualifiesShortTurn: boolean;
  eosToFirstAssistantStatusTextMs: number | null;
  eosToFirstAudibleByteMs: number | null;
  eosToFirstSemanticAssistantTextMs: number | null;
  eosToSemanticSpokenAnswerStartMs: number | null;
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
  spokenResponse?: string;
  audioBase64?: string;
  audioFormat?: string;
  audioChunks?: Array<{ audioBase64: string; audioFormat?: string }>;
  route?: string;
  model?: string;
  thinkingLevel?: string;
  runId?: string;
  conversationId?: string;
  turnId?: string;
  clientMessageId?: string;
  source?: string;
  userTranscriptMessageId?: string;
  userTranscriptMessage?: Record<string, unknown> | null;
  provisional?: boolean;
  toolActivity?: boolean;
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

export function withTurnTelemetry(
  base: VoiceTimings | null | undefined,
  telemetry: { micStartMs: number; firstSpeechMs?: number; totalMs: number },
): VoiceTimings {
  return {
    ...(base ?? { totalMs: telemetry.totalMs }),
    micStartMs: telemetry.micStartMs,
    firstSpeechMs: telemetry.firstSpeechMs,
    totalMs: base?.totalMs ?? telemetry.totalMs,
  };
}

function setVoiceStatusText(state: VoiceState, statusText: string): void {
  state.statusText = statusText;
  if (state.firstStatusTextAtMs == null) {
    state.firstStatusTextAtMs = Date.now();
  }
}

function isLikelyActionTurn(text: string | null | undefined): boolean {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) {
    return false;
  }
  return ACTION_TURN_PREFIX_REGEX.test(normalized) || ACTION_TURN_KEYWORD_REGEX.test(normalized);
}

function toOptionalMs(value: unknown): number | undefined {
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

function resolveTimingMsFromRecord(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = toOptionalMs(record[key]);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function estimateOutputTokens(text: string | null | undefined): number {
  if (!text || !text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function latencyFromEos(eosAtMs: number, targetAtMs: number | null): number | null {
  if (targetAtMs == null) {
    return null;
  }
  return Math.max(0, targetAtMs - eosAtMs);
}

function percentileMs(values: number[], percentile: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[rank] ?? sorted[sorted.length - 1] ?? 0);
}

function buildSloMetric(values: number[]): VoiceShortTurnSloMetric {
  return {
    count: values.length,
    p50Ms: percentileMs(values, 50),
    p95Ms: percentileMs(values, 95),
  };
}

function buildShortTurnSloReport(samples: VoiceShortTurnSloSample[]): VoiceShortTurnSloReport {
  const shortTurnSamples = samples.filter((sample) => sample.qualifiesShortTurn);
  const statusValues = shortTurnSamples.flatMap((sample) =>
    sample.eosToFirstAssistantStatusTextMs == null ? [] : [sample.eosToFirstAssistantStatusTextMs],
  );
  const firstAudibleValues = shortTurnSamples.flatMap((sample) =>
    sample.eosToFirstAudibleByteMs == null ? [] : [sample.eosToFirstAudibleByteMs],
  );
  const firstSemanticValues = shortTurnSamples.flatMap((sample) =>
    sample.eosToFirstSemanticAssistantTextMs == null
      ? []
      : [sample.eosToFirstSemanticAssistantTextMs],
  );
  const semanticSpokenValues = shortTurnSamples.flatMap((sample) =>
    sample.eosToSemanticSpokenAnswerStartMs == null
      ? []
      : [sample.eosToSemanticSpokenAnswerStartMs],
  );
  return {
    generatedAtMs: Date.now(),
    totalTurnCount: samples.length,
    shortTurnCount: shortTurnSamples.length,
    shortTurnSpeechMaxMs: SHORT_TURN_MAX_SPEECH_MS,
    shortTurnOutputTokenMax: SHORT_TURN_MAX_OUTPUT_TOKENS,
    metrics: {
      eosToFirstAssistantStatusText: buildSloMetric(statusValues),
      eosToFirstAudibleByte: buildSloMetric(firstAudibleValues),
      eosToFirstSemanticAssistantText: buildSloMetric(firstSemanticValues),
      eosToSemanticSpokenAnswerStart: buildSloMetric(semanticSpokenValues),
    },
  };
}

export function recordVoiceShortTurnSloSample(
  state: VoiceState,
  params: {
    turnId: string;
    eosAtMs: number;
    speechDurationMs: number | null;
    outputText: string | null | undefined;
  },
): void {
  const outputTokenEstimate = estimateOutputTokens(params.outputText);
  const qualifiesShortTurn =
    params.speechDurationMs != null &&
    params.speechDurationMs <= SHORT_TURN_MAX_SPEECH_MS &&
    outputTokenEstimate <= SHORT_TURN_MAX_OUTPUT_TOKENS;
  const sample: VoiceShortTurnSloSample = {
    turnId: params.turnId,
    capturedAtMs: Date.now(),
    eosAtMs: params.eosAtMs,
    speechDurationMs: params.speechDurationMs,
    outputTokenEstimate,
    qualifiesShortTurn,
    eosToFirstAssistantStatusTextMs: latencyFromEos(params.eosAtMs, state.firstStatusTextAtMs),
    eosToFirstAudibleByteMs: latencyFromEos(params.eosAtMs, state.firstAudibleAtMs),
    eosToFirstSemanticAssistantTextMs: latencyFromEos(params.eosAtMs, state.firstSemanticTextAtMs),
    eosToSemanticSpokenAnswerStartMs: latencyFromEos(params.eosAtMs, state.semanticSpokenStartAtMs),
  };
  state.shortTurnSloSamples.push(sample);
  if (state.shortTurnSloSamples.length > VOICE_SLO_SAMPLE_LIMIT) {
    state.shortTurnSloSamples.splice(0, state.shortTurnSloSamples.length - VOICE_SLO_SAMPLE_LIMIT);
  }
  state.shortTurnSloReport = buildShortTurnSloReport(state.shortTurnSloSamples);
  console.info("[Voice/SLO] short-turn-report", state.shortTurnSloReport);
}

function generateVoiceId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

function ensureConversationId(state: VoiceState): string {
  if (!state.conversationId) {
    state.conversationId = generateVoiceId("voice-conv");
  }
  return state.conversationId;
}

function transitionPhase(
  state: VoiceState,
  phase: ConversationPhase,
  meta?: {
    turnId?: string | null;
    interruptedBy?: VoiceInterruptedBy | null;
    resumedAt?: number | null;
  },
): void {
  state.phase = phase;
  state.phaseSeq += 1;
  state.transitionMeta = {
    turnId: meta?.turnId ?? state.currentTurnId ?? null,
    phase,
    interruptedBy: meta?.interruptedBy ?? null,
    resumedAt: meta?.resumedAt ?? null,
    ts: Date.now(),
    seq: state.phaseSeq,
  };
}

export function setConversationSessionContext(state: VoiceState, sessionKey: string | null): void {
  state.sessionKey = sessionKey;
  state.conversationSessionKey = sessionKey;
}

export function createVoiceTurnIdentity(state: VoiceState): {
  conversationId: string;
  turnId: string;
  clientMessageId: string;
} {
  const conversationId = ensureConversationId(state);
  const turnId = generateVoiceId("voice-turn");
  const clientMessageId = generateVoiceId("voice-msg");
  state.currentTurnId = turnId;
  state.currentClientMessageId = clientMessageId;
  return { conversationId, turnId, clientMessageId };
}

export function registerOptimisticVoiceTranscript(
  state: VoiceState,
  params: {
    clientMessageId: string;
    conversationId: string;
    turnId: string;
    optimisticMessageId: string;
  },
): void {
  const now = Date.now();
  state.transcriptReconcileByClientMessageId.set(params.clientMessageId, {
    clientMessageId: params.clientMessageId,
    conversationId: params.conversationId,
    turnId: params.turnId,
    optimisticMessageId: params.optimisticMessageId,
    confirmedMessageId: null,
    createdAtMs: now,
    updatedAtMs: now,
    status: "optimistic",
  });
}

export function markVoiceTranscriptConfirmed(
  state: VoiceState,
  params: { clientMessageId: string; confirmedMessageId?: string | null },
): boolean {
  const current = state.transcriptReconcileByClientMessageId.get(params.clientMessageId);
  if (!current) {
    return false;
  }
  current.status = "confirmed";
  current.confirmedMessageId = params.confirmedMessageId ?? current.confirmedMessageId;
  current.updatedAtMs = Date.now();
  state.transcriptReconcileByClientMessageId.set(params.clientMessageId, current);
  return true;
}

export function pruneStaleVoiceTranscriptReconciliations(
  state: VoiceState,
  now = Date.now(),
): string[] {
  const staleIds: string[] = [];
  for (const [clientMessageId, entry] of state.transcriptReconcileByClientMessageId) {
    const ageMs = now - entry.createdAtMs;
    const stale = entry.status !== "confirmed" && ageMs > VOICE_RECONCILE_STALE_MS;
    if (!stale) {
      continue;
    }
    staleIds.push(clientMessageId);
    state.transcriptReconcileByClientMessageId.delete(clientMessageId);
  }
  return staleIds;
}

export function pauseConversationForTextRun(
  state: VoiceState,
  params: { sessionKey: string; interruptedBy?: "text_send" | "approval_wait" },
): {
  conversationId: string;
  sessionKey: string;
  manualStopVersion: number;
} | null {
  if (!state.conversationActive) {
    return null;
  }
  const conversationId = ensureConversationId(state);
  const interruptedBy = params.interruptedBy ?? "text_send";
  state.conversationSessionKey = params.sessionKey;
  state.pausedTextRun = {
    conversationId,
    sessionKey: params.sessionKey,
    manualStopVersion: state.manualStopVersion,
    interruptedBy,
  };
  if (state.turnAbortController) {
    state.turnAbortController.abort();
  }
  stopPlayback(state);
  transitionPhase(state, interruptedBy === "approval_wait" ? "approval_wait" : "paused_text_run", {
    interruptedBy,
  });
  return {
    conversationId,
    sessionKey: params.sessionKey,
    manualStopVersion: state.manualStopVersion,
  };
}

export function resumeConversationAfterTextRun(
  state: VoiceState,
  params: { conversationId: string; sessionKey: string; manualStopVersion: number },
): boolean {
  if (!state.conversationActive) {
    return false;
  }
  if (state.manualStopVersion !== params.manualStopVersion) {
    return false;
  }
  if (state.conversationId !== params.conversationId) {
    return false;
  }
  if (state.conversationSessionKey && state.conversationSessionKey !== params.sessionKey) {
    return false;
  }
  state.pausedTextRun = null;
  transitionPhase(state, "listening", {
    resumedAt: Date.now(),
  });
  return true;
}

export function clearApprovalWait(state: VoiceState): void {
  if (state.phase !== "approval_wait") {
    return;
  }
  const resumed = resumeConversationAfterTextRun(state, {
    conversationId: state.conversationId ?? "",
    sessionKey: state.conversationSessionKey ?? state.sessionKey ?? "",
    manualStopVersion: state.manualStopVersion,
  });
  if (!resumed) {
    transitionPhase(state, "processing");
  }
}

export function markVoiceTurnCompleted(state: VoiceState, turnId: string | null): boolean {
  const id = typeof turnId === "string" ? turnId.trim() : "";
  if (!id) {
    return false;
  }
  if (state.completedTurnIds.has(id)) {
    return false;
  }
  state.completedTurnIds.add(id);
  if (state.completedTurnIds.size > 128) {
    const first = state.completedTurnIds.values().next().value;
    if (typeof first === "string") {
      state.completedTurnIds.delete(first);
    }
  }
  return true;
}

function clearSparkTtsStreamPending(entry: SparkTtsStreamPending): void {
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }
  if (entry.abortCleanup) {
    entry.abortCleanup();
    entry.abortCleanup = null;
  }
}

function rejectSparkTtsStream(state: VoiceState, streamId: string, reason: string): void {
  const pending = state.sparkTtsStreams.get(streamId);
  if (!pending) {
    return;
  }
  clearSparkTtsStreamPending(pending);
  state.sparkTtsStreams.delete(streamId);
  pending.reject(new Error(reason));
}

function resolveSparkTtsStream(state: VoiceState, streamId: string): void {
  const pending = state.sparkTtsStreams.get(streamId);
  if (!pending) {
    return;
  }
  const chunks = [...pending.chunks].toSorted((a, b) => a.seq - b.seq);
  if (pending.expectedTotalChunks != null && chunks.length !== pending.expectedTotalChunks) {
    rejectSparkTtsStream(state, streamId, "SPARK_TTS_STREAM_INCOMPLETE");
    return;
  }
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.seq !== index + 1) {
      rejectSparkTtsStream(state, streamId, "SPARK_TTS_STREAM_OUT_OF_ORDER");
      return;
    }
  }
  clearSparkTtsStreamPending(pending);
  state.sparkTtsStreams.delete(streamId);
  pending.resolve(chunks);
}

async function requestSparkTtsCancel(
  state: VoiceState,
  params: { streamId?: string; turnId?: string },
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("spark.voice.tts.cancel", {
      streamId: params.streamId,
      turnId: params.turnId,
      sessionKey: state.sessionKey ?? undefined,
      conversationId: state.conversationId ?? undefined,
    });
  } catch (err) {
    console.warn("[Voice/Spark] cancel request failed", err);
  }
}

function cancelAllSparkTtsStreams(state: VoiceState, reason: string): void {
  const streamIds = [...state.sparkTtsStreams.keys()];
  for (const streamId of streamIds) {
    rejectSparkTtsStream(state, streamId, reason);
  }
  if (!streamIds.length && !state.currentTurnId) {
    return;
  }
  const cancelOps = streamIds.map((streamId) =>
    requestSparkTtsCancel(state, {
      streamId,
      turnId: state.currentTurnId ?? undefined,
    }),
  );
  if (!streamIds.length && state.currentTurnId) {
    cancelOps.push(requestSparkTtsCancel(state, { turnId: state.currentTurnId }));
  }
  void Promise.all(cancelOps).catch(() => undefined);
}

async function waitForSparkTtsStream(params: {
  state: VoiceState;
  streamId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<SparkTtsStreamChunk[]> {
  return await new Promise<SparkTtsStreamChunk[]>((resolve, reject) => {
    const pending: SparkTtsStreamPending = {
      chunks: [],
      seenSeq: new Set<number>(),
      expectedTotalChunks: null,
      resolve,
      reject,
      timeoutHandle: null,
      abortCleanup: null,
    };
    pending.timeoutHandle = setTimeout(() => {
      rejectSparkTtsStream(params.state, params.streamId, "SPARK_TTS_STREAM_TIMEOUT");
    }, params.timeoutMs);

    if (params.signal) {
      const onAbort = () => {
        rejectSparkTtsStream(params.state, params.streamId, "VOICE_TURN_ABORTED");
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      pending.abortCleanup = () => {
        params.signal?.removeEventListener("abort", onAbort);
      };
    }

    params.state.sparkTtsStreams.set(params.streamId, pending);
  });
}

export function handleSparkVoiceStreamEvent(
  state: VoiceState,
  event: VoiceSparkStreamEventName,
  payload: Record<string, unknown>,
): void {
  const streamIdRaw = payload.streamId;
  const streamId =
    typeof streamIdRaw === "string" && streamIdRaw.trim() ? streamIdRaw.trim() : null;
  if (!streamId) {
    return;
  }

  if (event === "spark.voice.stream.started") {
    // Stream start is informational, chunk/completed events drive completion.
    return;
  }

  if (event === "spark.voice.stream.chunk") {
    const pending = state.sparkTtsStreams.get(streamId);
    if (!pending) {
      return;
    }
    const seqRaw = payload.seq;
    const seq =
      typeof seqRaw === "number" && Number.isFinite(seqRaw) ? Math.max(1, Math.trunc(seqRaw)) : 1;
    const audioBase64Raw = payload.audioBase64 ?? payload.audio_base64;
    const audioBase64 =
      typeof audioBase64Raw === "string" && audioBase64Raw.length > 0 ? audioBase64Raw : "";
    if (!audioBase64) {
      return;
    }
    if (pending.seenSeq.has(seq)) {
      return;
    }
    if (pending.expectedTotalChunks != null && seq > pending.expectedTotalChunks) {
      rejectSparkTtsStream(state, streamId, "SPARK_TTS_STREAM_SEQ_OUT_OF_RANGE");
      return;
    }
    const formatRaw = payload.format;
    const audioFormat =
      typeof formatRaw === "string" && formatRaw.trim() ? formatRaw.trim() : "webm";
    const sampleRateRaw = payload.sampleRate ?? payload.sample_rate;
    const sampleRate =
      typeof sampleRateRaw === "number" && Number.isFinite(sampleRateRaw)
        ? Math.max(1, Math.trunc(sampleRateRaw))
        : undefined;
    const isLastRaw = payload.isLast ?? payload.is_last;
    const isLast = typeof isLastRaw === "boolean" ? isLastRaw : undefined;
    const chunkDurationRaw = payload.chunkDurationMs ?? payload.chunk_duration_ms;
    const chunkDurationMs =
      typeof chunkDurationRaw === "number" && Number.isFinite(chunkDurationRaw)
        ? Math.max(0, Math.round(chunkDurationRaw))
        : undefined;
    pending.seenSeq.add(seq);
    if (isLast && pending.expectedTotalChunks == null) {
      pending.expectedTotalChunks = seq;
    }
    pending.chunks.push({ seq, audioBase64, audioFormat, sampleRate, isLast, chunkDurationMs });
    return;
  }

  if (event === "spark.voice.stream.completed") {
    const pending = state.sparkTtsStreams.get(streamId);
    if (pending) {
      const totalChunksRaw = payload.totalChunks;
      const totalChunks =
        typeof totalChunksRaw === "number" && Number.isFinite(totalChunksRaw)
          ? Math.max(0, Math.trunc(totalChunksRaw))
          : null;
      pending.expectedTotalChunks = totalChunks;
    }
    resolveSparkTtsStream(state, streamId);
    return;
  }

  if (event === "spark.voice.stream.error") {
    const message =
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "SPARK_TTS_STREAM_FAILED";
    rejectSparkTtsStream(state, streamId, message);
  }
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
    turnAbortController: null,
    conversationId: null,
    conversationSessionKey: null,
    currentTurnId: null,
    currentClientMessageId: null,
    transitionMeta: null,
    phaseSeq: 0,
    manualStopVersion: 0,
    pausedTextRun: null,
    completedTurnIds: new Set<string>(),
    transcriptReconcileByClientMessageId: new Map<string, VoiceTranscriptReconcileEntry>(),
    statusText: null,
    firstStatusTextAtMs: null,
    firstAudibleAtMs: null,
    firstSemanticTextAtMs: null,
    semanticSpokenStartAtMs: null,
    shortTurnSloSamples: [],
    shortTurnSloReport: null,
    sparkTtsStreamSupport: "unknown",
    sparkTtsStreams: new Map<string, SparkTtsStreamPending>(),

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
    captureWorkletSource: null,
    captureWorkletNode: null,
    captureWorkletSink: null,
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
    lastRoute: null,
    lastModel: null,
    lastThinkingLevel: null,
    routeModelWarning: null,

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
    const result = await state.client.request<VoiceStatusResult>("voice.status", {});

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

async function playBackchannelBeep(state: VoiceState): Promise<void> {
  if (!state.conversationActive) {
    return;
  }
  const ctx = state.playbackContext ?? new AudioContext();
  if (!state.playbackContext) {
    state.playbackContext = ctx;
  }
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.value = 0.0001;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  const now = ctx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + BACKCHANNEL_BEEP_DURATION_MS / 1000);
  oscillator.start(now);
  oscillator.stop(now + BACKCHANNEL_BEEP_DURATION_MS / 1000);
  state.firstAudibleAtMs = Date.now();
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
  let sink: GainNode | null = null;

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

    // Keep the worklet node in an active render graph without audible output.
    sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    state.captureWorkletContext = ctx;
    state.captureWorkletSource = source;
    state.captureWorkletNode = node;
    state.captureWorkletSink = sink;
    state.captureUsingWorklet = true;
    return true;
  } catch (err) {
    console.warn("[Voice] Worklet capture unavailable, falling back to MediaRecorder", err);
    state.captureWorkletDisabledForSession = true;
    state.captureUsingWorklet = false;
    state.capturePcmFrames = [];
    state.captureWorkletSource = null;
    state.captureWorkletNode = null;
    state.captureWorkletSink = null;
    state.captureWorkletContext = null;
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
      sink?.disconnect();
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

  const source = state.captureWorkletSource;
  const node = state.captureWorkletNode;
  const sink = state.captureWorkletSink;
  const ctx = state.captureWorkletContext;
  state.captureWorkletSource = null;
  state.captureWorkletNode = null;
  state.captureWorkletSink = null;
  state.captureWorkletContext = null;

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
    sink?.disconnect();
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
    state.captureWorkletSource = null;
    state.captureWorkletNode = null;
    state.captureWorkletSink = null;
    state.captureWorkletContext = null;

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
  cancelAllSparkTtsStreams(state, "VOICE_TURN_ABORTED");

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

  if (state.captureWorkletSource) {
    try {
      state.captureWorkletSource.disconnect();
    } catch {
      // ignore
    }
    state.captureWorkletSource = null;
  }
  if (state.captureWorkletNode) {
    try {
      state.captureWorkletNode.disconnect();
    } catch {
      // ignore
    }
    state.captureWorkletNode = null;
  }
  if (state.captureWorkletSink) {
    try {
      state.captureWorkletSink.disconnect();
    } catch {
      // ignore
    }
    state.captureWorkletSink = null;
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
  state.statusText = null;
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

function inferRouteHosting(route: string | null | undefined): "local" | "cloud" | null {
  if (!route) {
    return null;
  }
  const normalized = route.toLowerCase();
  if (normalized.includes("local")) {
    return "local";
  }
  if (normalized.includes("cloud")) {
    return "cloud";
  }
  return null;
}

function inferModelHosting(model: string | null | undefined): "local" | "cloud" | null {
  if (!model) {
    return null;
  }
  const normalized = model.toLowerCase();
  if (normalized.startsWith("ollama/") || normalized.startsWith("spark-ollama/")) {
    return "local";
  }
  return "cloud";
}

function setVoiceAttribution(
  state: VoiceState,
  source: string,
  route: string | null | undefined,
  model: string | null | undefined,
  thinkingLevel: string | null | undefined,
): void {
  const resolvedRoute = route?.trim() ? route.trim() : null;
  const resolvedModel = model?.trim() ? model.trim() : null;
  const resolvedThinking = thinkingLevel?.trim() ? thinkingLevel.trim() : null;

  state.lastRoute = resolvedRoute;
  state.lastModel = resolvedModel;
  state.lastThinkingLevel = resolvedThinking;
  state.routeModelWarning = null;

  if (!resolvedRoute && !resolvedModel && !resolvedThinking) {
    return;
  }

  const routeHosting = inferRouteHosting(resolvedRoute);
  const modelHosting = inferModelHosting(resolvedModel);

  if (routeHosting && modelHosting && routeHosting !== modelHosting) {
    const warning = `route/model mismatch: route=${resolvedRoute}, model=${resolvedModel}`;
    state.routeModelWarning = warning;
    console.warn("[voice/attribution]", {
      event: "route_model_mismatch",
      source,
      route: resolvedRoute,
      model: resolvedModel,
      routeHosting,
      modelHosting,
      thinkingLevel: resolvedThinking,
      ts: Date.now(),
    });
    return;
  }

  console.info("[voice/attribution]", {
    event: "route_model",
    source,
    route: resolvedRoute,
    model: resolvedModel,
    routeHosting,
    modelHosting,
    thinkingLevel: resolvedThinking,
    ts: Date.now(),
  });
}

/**
 * Process voice input through full pipeline.
 */
export async function processVoiceInput(
  state: VoiceState,
  audioBase64: string,
  signal?: AbortSignal,
  options?: {
    conversationId?: string;
    turnId?: string;
    clientMessageId?: string;
    source?: "voice";
  },
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    console.error("[Voice] Not connected to gateway");
    return null;
  }
  if (signal?.aborted) {
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
      conversationId: options?.conversationId,
      turnId: options?.turnId,
      clientMessageId: options?.clientMessageId,
      source: options?.source ?? "voice",
    };
    if (state.sessionKey) {
      request.sessionKey = state.sessionKey;
    }
    const result = await state.client.request<VoiceProcessResult>(
      "voice.process",
      {
        ...request,
      },
      { signal },
    );

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
    setVoiceAttribution(state, "voice.process", result.route, result.model, result.thinkingLevel);

    return {
      ...result,
      conversationId: result.conversationId ?? options?.conversationId,
      turnId: result.turnId ?? options?.turnId,
      clientMessageId: result.clientMessageId ?? options?.clientMessageId,
      source: result.source ?? options?.source ?? "voice",
      spokenResponse:
        typeof result.spokenResponse === "string"
          ? normalizeTextForDisplay(result.spokenResponse)
          : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "request aborted" || message === "VOICE_TURN_ABORTED") {
      state.error = null;
      return null;
    }
    console.error("[Voice] Processing error:", err);
    state.error = String(err);
    return null;
  }
}

async function requestWithTimeout<T>(params: {
  request: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  timeoutCode: string;
  externalSignal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let externallyAborted = false;

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };

  if (params.externalSignal?.aborted) {
    throw new Error("VOICE_TURN_ABORTED");
  }
  params.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(params.timeoutCode));
      }, params.timeoutMs);
    });

    return await Promise.race([params.request(controller.signal), timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      throw new Error(params.timeoutCode, { cause: err });
    }
    if (externallyAborted || params.externalSignal?.aborted) {
      throw new Error("VOICE_TURN_ABORTED", { cause: err });
    }
    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    params.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function requestSparkTtsStreamChunks(params: {
  state: VoiceState;
  client: GatewayBrowserClient;
  text: string;
  format: string;
  requestId?: string;
  sessionKey?: string;
  conversationId?: string;
  turnId?: string;
  clientMessageId?: string;
  source?: string;
  voice?: string;
  instruct?: string;
  language?: string;
  signal?: AbortSignal;
}): Promise<SparkTtsStreamChunk[]> {
  const streamIdRequested = generateVoiceId("spark-tts-stream");
  let streamIdActive = streamIdRequested;
  const streamPromise = waitForSparkTtsStream({
    state: params.state,
    streamId: streamIdRequested,
    signal: params.signal,
    timeoutMs: SPARK_TTS_TIMEOUT_MS + 5_000,
  });

  try {
    const streamStartResult = (await requestWithTimeout({
      request: (requestSignal) =>
        params.client.request(
          "spark.voice.tts.stream",
          {
            streamId: streamIdRequested,
            text: params.text,
            format: params.format,
            requestId: params.requestId,
            sessionKey: params.sessionKey,
            conversationId: params.conversationId,
            turnId: params.turnId,
            clientMessageId: params.clientMessageId,
            source: params.source,
            voice: params.voice,
            instruct: params.instruct,
            language: params.language,
          },
          { signal: requestSignal },
        ) as Promise<Record<string, unknown>>,
      timeoutMs: SPARK_TTS_TIMEOUT_MS,
      timeoutCode: "SPARK_TTS_STREAM_START_TIMEOUT",
      externalSignal: params.signal,
    })) as Record<string, unknown>;

    const ackStreamIdRaw = streamStartResult?.streamId;
    const ackStreamId =
      typeof ackStreamIdRaw === "string" && ackStreamIdRaw.trim()
        ? ackStreamIdRaw.trim()
        : streamIdRequested;

    if (ackStreamId !== streamIdRequested) {
      const pending = params.state.sparkTtsStreams.get(streamIdRequested);
      if (pending) {
        params.state.sparkTtsStreams.delete(streamIdRequested);
        params.state.sparkTtsStreams.set(ackStreamId, pending);
      }
      streamIdActive = ackStreamId;
    }

    if (streamStartResult?.accepted === false) {
      throw new Error("SPARK_TTS_STREAM_REJECTED");
    }

    return await streamPromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rejectSparkTtsStream(params.state, streamIdActive, message);
    if (streamIdActive !== streamIdRequested) {
      rejectSparkTtsStream(params.state, streamIdRequested, message);
    }
    void requestSparkTtsCancel(params.state, {
      streamId: streamIdActive,
      turnId: params.turnId,
    });
    throw err;
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
export type VoiceSparkTurnOptions = {
  conversationId?: string;
  turnId?: string;
  clientMessageId?: string;
  source?: "voice";
  spokenOutputMode?: "concise" | "full" | "status";
  onStatusText?: (statusText: string) => void;
  onTranscription?: (params: {
    text: string;
    conversationId: string;
    turnId: string;
    clientMessageId: string;
  }) => void;
};

export async function processVoiceInputSpark(
  state: VoiceState,
  audioBase64: string,
  format = "webm",
  signal?: AbortSignal,
  options?: VoiceSparkTurnOptions,
): Promise<VoiceProcessResult | null> {
  const client = state.client;
  if (!client || !state.connected) {
    console.error("[Voice/Spark] Not connected to gateway");
    return null;
  }
  if (signal?.aborted) {
    return null;
  }

  state.error = null;
  state.transcription = null;
  state.response = null;
  state.timings = null;

  try {
    const startedAt = Date.now();
    const conversationId = options?.conversationId ?? ensureConversationId(state);
    const turnId = options?.turnId ?? state.currentTurnId ?? generateVoiceId("voice-turn");
    const clientMessageId =
      options?.clientMessageId ?? state.currentClientMessageId ?? generateVoiceId("voice-msg");
    const voiceSource = options?.source ?? "voice";
    const sttRequestId = `${turnId}-stt`;
    const llmRequestId = `${turnId}-llm`;
    const ttsRequestId = `${turnId}-tts`;

    setVoiceStatusText(state, "Working on it...");
    options?.onStatusText?.(state.statusText ?? "Working on it...");

    // 1) STT
    console.log("[Voice/Spark] Sending audio to spark.voice.stt...");
    const sttStart = Date.now();
    let sttResult: Record<string, unknown>;
    try {
      sttResult = await requestWithTimeout({
        request: (requestSignal) =>
          client.request(
            "spark.voice.stt",
            {
              audio_base64: audioBase64,
              format,
              requestId: sttRequestId,
              sessionKey: state.sessionKey ?? undefined,
              conversationId,
              turnId,
              clientMessageId,
              source: voiceSource,
            },
            { signal: requestSignal },
          ) as Promise<Record<string, unknown>>,
        timeoutMs: SPARK_STT_TIMEOUT_MS,
        timeoutCode: "SPARK_STT_TIMEOUT",
        externalSignal: signal,
      });
    } catch (sttErr) {
      const code = sttErr instanceof Error ? sttErr.message : String(sttErr);
      if (code === "VOICE_TURN_ABORTED") {
        state.error = null;
      } else if (code === "SPARK_STT_TIMEOUT") {
        state.error = "Speech recognition timed out. Try a shorter phrase.";
      } else {
        state.error = `STT failed: ${code}`;
      }
      state.timings = { sttMs: Date.now() - sttStart, totalMs: Date.now() - startedAt };
      return null;
    }
    const sttTimingsRecord =
      sttResult?.timings_ms && typeof sttResult.timings_ms === "object"
        ? (sttResult.timings_ms as Record<string, unknown>)
        : undefined;
    const sttMs =
      resolveTimingMsFromRecord(sttTimingsRecord, [
        "gateway_total_ms",
        "total_ms",
        "dgx_total_ms",
      ]) ?? Date.now() - sttStart;

    const text = sttResult?.text ?? "";
    state.transcription = typeof text === "string" ? normalizeTextForDisplay(text) : "";
    if (state.transcription.trim()) {
      options?.onTranscription?.({
        text: state.transcription,
        conversationId,
        turnId,
        clientMessageId,
      });
    }

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
    const spokenOutputMode = options?.spokenOutputMode ?? "concise";
    const requestVoiceProcessText = (params: {
      requestId: string;
      provisional: boolean;
      latencyProfile: "default" | "short_turn_fast";
      spokenOutputMode?: "concise" | "full" | "status";
      allowTools: boolean;
      maxOutputTokens?: number;
      timeoutMs: number;
      timeoutCode: string;
    }) =>
      requestWithTimeout({
        request: (requestSignal) =>
          client.request(
            "voice.processText",
            {
              text: state.transcription,
              requestId: params.requestId,
              sessionKey: state.sessionKey ?? undefined,
              driveOpenClaw: state.driveOpenClaw,
              skipTts: true,
              conversationId,
              turnId,
              clientMessageId,
              source: voiceSource,
              spokenOutputMode: params.spokenOutputMode ?? spokenOutputMode,
              latencyProfile: params.latencyProfile,
              allowTools: params.allowTools,
              maxOutputTokens: params.maxOutputTokens,
              provisional: params.provisional,
            },
            { signal: requestSignal },
          ) as Promise<Record<string, unknown>>,
        timeoutMs: params.timeoutMs,
        timeoutCode: params.timeoutCode,
        externalSignal: signal,
      });
    const canonicalReplyPromise = requestVoiceProcessText({
      requestId: llmRequestId,
      provisional: false,
      latencyProfile: "default",
      spokenOutputMode,
      allowTools: true,
      maxOutputTokens: SHORT_TURN_MAX_OUTPUT_TOKENS,
      timeoutMs: SPARK_LLM_TIMEOUT_MS,
      timeoutCode: "SPARK_LLM_TIMEOUT",
    });
    const actionTurnLikely = isLikelyActionTurn(state.transcription);
    const provisionalSpokenOutputMode: "concise" | "full" | "status" = actionTurnLikely
      ? "status"
      : spokenOutputMode;
    const allowProvisionalReply = options?.spokenOutputMode != null;
    const provisionalReplyPromise = !allowProvisionalReply
      ? null
      : requestVoiceProcessText({
          requestId: `${turnId}-llm-provisional`,
          provisional: true,
          latencyProfile: "short_turn_fast",
          spokenOutputMode: provisionalSpokenOutputMode,
          allowTools: false,
          maxOutputTokens: PROVISIONAL_MAX_OUTPUT_TOKENS,
          timeoutMs: SPARK_LLM_PROVISIONAL_TIMEOUT_MS,
          timeoutCode: "SPARK_LLM_PROVISIONAL_TIMEOUT",
        }).catch((err) => {
          const code = err instanceof Error ? err.message : String(err);
          if (code !== "VOICE_TURN_ABORTED" && code !== "SPARK_LLM_PROVISIONAL_TIMEOUT") {
            console.warn("[Voice/Spark] provisional LLM failed:", code);
          }
          return null;
        });
    const hasReplyText = (
      payload: Record<string, unknown> | null,
    ): payload is Record<string, unknown> => {
      if (!payload) {
        return false;
      }
      const candidate =
        typeof payload.spokenResponse === "string"
          ? payload.spokenResponse
          : typeof payload.response === "string"
            ? payload.response
            : "";
      return candidate.trim().length > 0;
    };
    let reply: Record<string, unknown>;
    let usedProvisional = false;
    try {
      if (provisionalReplyPromise) {
        const firstSettled = await Promise.race([
          canonicalReplyPromise.then((payload) => ({ kind: "canonical" as const, payload })),
          provisionalReplyPromise.then((payload) => ({ kind: "provisional" as const, payload })),
        ]);
        if (firstSettled.kind === "provisional" && hasReplyText(firstSettled.payload)) {
          usedProvisional = true;
          reply = firstSettled.payload;
          setVoiceStatusText(state, "Finalizing full answer...");
          options?.onStatusText?.(state.statusText ?? "Finalizing full answer...");
          void canonicalReplyPromise
            .then((canonicalReply) => {
              const canonicalToolActivity = canonicalReply?.toolActivity === true;
              if (
                canonicalToolActivity &&
                state.currentTurnId === turnId &&
                state.phase === "speaking"
              ) {
                stopPlayback(state);
                const interimStatus = "Working on that action now...";
                setVoiceStatusText(state, interimStatus);
                options?.onStatusText?.(interimStatus);
              }
              const canonicalTextRaw = canonicalReply?.response;
              const canonicalText =
                typeof canonicalTextRaw === "string"
                  ? normalizeTextForDisplay(canonicalTextRaw)
                  : "";
              if (!canonicalText.trim()) {
                return;
              }
              if (state.currentTurnId !== turnId) {
                return;
              }
              state.response = canonicalText;
            })
            .catch((err) => {
              const code = err instanceof Error ? err.message : String(err);
              if (code !== "VOICE_TURN_ABORTED") {
                console.warn("[Voice/Spark] canonical LLM failed after provisional reply:", code);
              }
            });
        } else if (firstSettled.kind === "canonical") {
          reply = firstSettled.payload;
        } else {
          reply = await canonicalReplyPromise;
        }
      } else {
        reply = await canonicalReplyPromise;
      }
    } catch (llmErr) {
      const code = llmErr instanceof Error ? llmErr.message : String(llmErr);
      state.error =
        code === "VOICE_TURN_ABORTED"
          ? null
          : code === "SPARK_LLM_TIMEOUT"
            ? "Response generation timed out. Try a shorter request."
            : `LLM failed: ${code}`;
      state.timings = {
        sttMs,
        llmMs: Date.now() - llmStart,
        totalMs: Date.now() - startedAt,
      };
      return null;
    }
    const llmTimingsRecord =
      reply?.timings && typeof reply.timings === "object"
        ? (reply.timings as Record<string, unknown>)
        : undefined;
    const llmFirstSemanticMs = resolveTimingMsFromRecord(llmTimingsRecord, [
      "llmFirstSemanticMs",
      "llm_first_semantic_ms",
    ]);
    const llmFullCompletionMs = resolveTimingMsFromRecord(llmTimingsRecord, [
      "llmFullCompletionMs",
      "llm_full_completion_ms",
      "llmMs",
      "llm_ms",
    ]);
    const llmMs = llmFullCompletionMs ?? Date.now() - llmStart;

    const responseTextRaw = reply?.response;
    const responseText =
      typeof responseTextRaw === "string" ? normalizeTextForDisplay(responseTextRaw) : "";
    const spokenResponseRaw = reply?.spokenResponse;
    const spokenResponse =
      typeof spokenResponseRaw === "string"
        ? normalizeTextForDisplay(spokenResponseRaw)
        : responseText;
    state.response = responseText;
    if (responseText.trim()) {
      state.firstSemanticTextAtMs =
        llmFirstSemanticMs != null ? llmStart + llmFirstSemanticMs : Date.now();
    }

    const baseResult: VoiceProcessResult = {
      sessionId:
        typeof (reply as Record<string, unknown>)?.sessionId === "string"
          ? ((reply as Record<string, unknown>).sessionId as string)
          : "",
      transcription: state.transcription,
      response: responseText,
      spokenResponse,
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
      conversationId:
        typeof (reply as Record<string, unknown>)?.conversationId === "string"
          ? ((reply as Record<string, unknown>).conversationId as string)
          : conversationId,
      turnId:
        typeof (reply as Record<string, unknown>)?.turnId === "string"
          ? ((reply as Record<string, unknown>).turnId as string)
          : turnId,
      clientMessageId:
        typeof (reply as Record<string, unknown>)?.clientMessageId === "string"
          ? ((reply as Record<string, unknown>).clientMessageId as string)
          : clientMessageId,
      source:
        typeof (reply as Record<string, unknown>)?.source === "string"
          ? ((reply as Record<string, unknown>).source as string)
          : voiceSource,
      userTranscriptMessageId:
        typeof (reply as Record<string, unknown>)?.userTranscriptMessageId === "string"
          ? ((reply as Record<string, unknown>).userTranscriptMessageId as string)
          : undefined,
      userTranscriptMessage:
        (reply as Record<string, unknown>)?.userTranscriptMessage &&
        typeof (reply as Record<string, unknown>)?.userTranscriptMessage === "object"
          ? ((reply as Record<string, unknown>).userTranscriptMessage as Record<string, unknown>)
          : null,
      provisional:
        (reply as Record<string, unknown>)?.provisional === true
          ? true
          : usedProvisional || undefined,
      toolActivity: (reply as Record<string, unknown>)?.toolActivity === true ? true : undefined,
    };

    setVoiceAttribution(
      state,
      "voice.processText",
      baseResult.route,
      baseResult.model,
      baseResult.thinkingLevel,
    );

    if (!responseText.trim()) {
      state.timings = {
        sttMs,
        llmMs,
        ...(llmFirstSemanticMs != null ? { llmFirstSemanticMs } : {}),
        ...(llmFullCompletionMs != null ? { llmFullCompletionMs } : {}),
        totalMs: Date.now() - startedAt,
      };
      return {
        ...baseResult,
        timings: state.timings,
      };
    }

    // 3) TTS via Spark
    const ttsInput = normalizeTextForTts(spokenResponse || responseText);
    if (!ttsInput) {
      state.timings = {
        sttMs,
        llmMs,
        ...(llmFirstSemanticMs != null ? { llmFirstSemanticMs } : {}),
        ...(llmFullCompletionMs != null ? { llmFullCompletionMs } : {}),
        totalMs: Date.now() - startedAt,
      };
      return {
        ...baseResult,
        timings: state.timings,
      };
    }

    const ttsStart = Date.now();
    let ttsResult: Record<string, unknown> | null = null;
    let streamedChunks: SparkTtsStreamChunk[] | null = null;
    const ttsParams: Record<string, unknown> = {
      text: ttsInput,
      format: "webm",
      requestId: ttsRequestId,
      sessionKey: state.sessionKey ?? undefined,
      conversationId,
      turnId,
      clientMessageId,
      source: voiceSource,
    };
    const ttsVoice =
      state.ttsVoice != null && state.ttsVoice.trim() !== "" ? state.ttsVoice.trim() : undefined;
    const ttsInstruct =
      state.ttsInstruct != null && state.ttsInstruct.trim() !== ""
        ? state.ttsInstruct.trim()
        : undefined;
    const ttsLanguage =
      state.ttsLanguage != null && state.ttsLanguage.trim() !== ""
        ? state.ttsLanguage.trim()
        : undefined;
    if (ttsVoice) {
      ttsParams.voice = ttsVoice;
    }
    if (ttsInstruct) {
      ttsParams.instruct = ttsInstruct;
    }
    if (ttsLanguage) {
      ttsParams.language = ttsLanguage;
    }
    if (state.sparkTtsStreamSupport !== "unsupported") {
      try {
        streamedChunks = await requestSparkTtsStreamChunks({
          state,
          client,
          text: ttsInput,
          format: "webm",
          requestId: ttsRequestId,
          sessionKey: state.sessionKey ?? undefined,
          conversationId,
          turnId,
          clientMessageId,
          source: voiceSource,
          voice: ttsVoice,
          instruct: ttsInstruct,
          language: ttsLanguage,
          signal,
        });
        if (streamedChunks.length > 0) {
          state.sparkTtsStreamSupport = "supported";
        }
      } catch (streamErr) {
        const code = streamErr instanceof Error ? streamErr.message : String(streamErr);
        if (
          code.toLowerCase().includes("unknown method") ||
          code.toLowerCase().includes("spark.voice.tts.stream")
        ) {
          state.sparkTtsStreamSupport = "unsupported";
        }
        console.warn("[Voice/Spark] TTS stream unavailable, falling back:", code);
      }
    }

    if (!streamedChunks || streamedChunks.length === 0) {
      try {
        ttsResult = await requestWithTimeout({
          request: (requestSignal) =>
            client.request("spark.voice.tts", ttsParams, {
              signal: requestSignal,
            }) as Promise<Record<string, unknown>>,
          timeoutMs: SPARK_TTS_TIMEOUT_MS,
          timeoutCode: "SPARK_TTS_TIMEOUT",
          externalSignal: signal,
        });
      } catch (ttsErr) {
        const code = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
        if (code === "VOICE_TURN_ABORTED") {
          state.error = null;
        } else if (code === "SPARK_TTS_TIMEOUT") {
          state.error = "TTS timed out. Returning text response only.";
        } else {
          console.error("[Voice/Spark] TTS error:", ttsErr);
          state.error = `TTS failed: ${code}`;
        }
      }
    }
    const ttsTimingsRecord =
      ttsResult?.timings_ms && typeof ttsResult.timings_ms === "object"
        ? (ttsResult.timings_ms as Record<string, unknown>)
        : undefined;
    const ttsMs =
      resolveTimingMsFromRecord(ttsTimingsRecord, ["total_ms", "tts_total_ms", "compute_ms"]) ??
      Date.now() - ttsStart;

    const fallbackAudio = ttsResult?.audio_base64;
    const fallbackFormat = ttsResult?.format;
    const audioChunks =
      streamedChunks && streamedChunks.length > 0
        ? streamedChunks.map((chunk) => ({
            audioBase64: chunk.audioBase64,
            audioFormat: chunk.audioFormat,
          }))
        : typeof fallbackAudio === "string" && fallbackAudio.length > 0
          ? [
              {
                audioBase64: fallbackAudio,
                audioFormat: typeof fallbackFormat === "string" ? fallbackFormat : "webm",
              },
            ]
          : [];
    if (audioChunks.length > 0) {
      state.semanticSpokenStartAtMs = Date.now();
    }

    state.timings = {
      sttMs,
      llmMs,
      ...(llmFirstSemanticMs != null ? { llmFirstSemanticMs } : {}),
      ...(llmFullCompletionMs != null ? { llmFullCompletionMs } : {}),
      ttsMs,
      totalMs: Date.now() - startedAt,
    };

    return {
      ...baseResult,
      audioBase64: audioChunks[0]?.audioBase64,
      audioFormat: audioChunks[0]?.audioFormat ?? "webm",
      audioChunks,
      timings: state.timings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "VOICE_TURN_ABORTED" || message === "request aborted") {
      state.error = null;
      return null;
    }
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
  signal?: AbortSignal,
  options?: {
    conversationId?: string;
    turnId?: string;
    clientMessageId?: string;
    source?: "voice";
    spokenOutputMode?: "concise" | "full" | "status";
    latencyProfile?: "default" | "short_turn_fast";
    allowTools?: boolean;
    maxOutputTokens?: number;
    provisional?: boolean;
  },
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }

  state.error = null;
  state.transcription = normalizeTextForDisplay(text);
  state.response = null;
  state.timings = null;

  try {
    const result = await state.client.request<VoiceProcessResult>(
      "voice.processText",
      {
        text,
        sessionKey: state.sessionKey ?? undefined,
        driveOpenClaw: state.driveOpenClaw,
        conversationId: options?.conversationId,
        turnId: options?.turnId,
        clientMessageId: options?.clientMessageId,
        source: options?.source ?? "voice",
        spokenOutputMode: options?.spokenOutputMode ?? "concise",
        latencyProfile: options?.latencyProfile,
        allowTools: options?.allowTools,
        maxOutputTokens: options?.maxOutputTokens,
        provisional: options?.provisional,
      },
      { signal },
    );

    state.response =
      typeof result.response === "string" ? normalizeTextForDisplay(result.response) : null;
    state.timings = result.timings ?? null;
    setVoiceAttribution(
      state,
      "voice.processText",
      result.route,
      result.model,
      result.thinkingLevel,
    );

    return {
      ...result,
      conversationId: result.conversationId ?? options?.conversationId,
      turnId: result.turnId ?? options?.turnId,
      clientMessageId: result.clientMessageId ?? options?.clientMessageId,
      source: result.source ?? options?.source ?? "voice",
      spokenResponse:
        typeof result.spokenResponse === "string"
          ? normalizeTextForDisplay(result.spokenResponse)
          : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "request aborted" || message === "VOICE_TURN_ABORTED") {
      state.error = null;
      return null;
    }
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
    const result = await state.client.request<{ text?: string }>("voice.transcribe", {
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
    const result = await state.client.request<VoiceSynthesizeResult>("voice.synthesize", {
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
    transitionPhase(state, "speaking");
    state.semanticSpokenStartAtMs = Date.now();
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
  onProcess: (input: {
    audioBase64: string;
    format: string;
    signal: AbortSignal;
    conversationId: string;
    turnId: string;
    clientMessageId: string;
  }) => Promise<VoiceProcessResult | null>,
): Promise<void> {
  if (state.conversationActive) {
    return;
  }
  if (state.mode === "spark" && !state.sparkVoiceAvailable) {
    state.error = "Spark voice is unavailable. Check DGX voice health and try again.";
    transitionPhase(state, "idle", { interruptedBy: "spark_unavailable" });
    onUpdate();
    return;
  }

  console.log("[Voice] Starting conversation...");
  state.conversationId = generateVoiceId("voice-conv");
  state.conversationSessionKey = state.sessionKey;
  state.conversationActive = true;
  state.manualStopVersion += 1;
  state.pausedTextRun = null;
  state.currentTurnId = null;
  state.currentClientMessageId = null;
  transitionPhase(state, "listening");
  state.error = null;
  state.transcription = null;
  state.response = null;
  state.statusText = null;
  state.firstStatusTextAtMs = null;
  state.firstAudibleAtMs = null;
  state.firstSemanticTextAtMs = null;
  state.semanticSpokenStartAtMs = null;
  state.lastRoute = null;
  state.lastModel = null;
  state.lastThinkingLevel = null;
  state.routeModelWarning = null;
  onUpdate();

  const waitForConversationResume = async () => {
    while (
      state.conversationActive &&
      (state.phase === "paused_text_run" || state.phase === "approval_wait")
    ) {
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  // Conversation loop - continues until user clicks stop
  while (state.conversationActive && state.connected && state.enabled) {
    await waitForConversationResume();
    if (!state.conversationActive) {
      break;
    }

    const turnId = generateVoiceId("voice-turn");
    const clientMessageId = generateVoiceId("voice-msg");
    state.currentTurnId = turnId;
    state.currentClientMessageId = clientMessageId;
    state.statusText = null;
    state.firstStatusTextAtMs = null;
    state.firstAudibleAtMs = null;
    state.firstSemanticTextAtMs = null;
    state.semanticSpokenStartAtMs = null;
    transitionPhase(state, "listening", { turnId });

    const turnAbortController = new AbortController();
    state.turnAbortController = turnAbortController;
    try {
      console.log("[Voice] Starting new turn, phase: listening");

      const turnStartedAt = Date.now();
      const micStartPerf = performance.now();
      const micStartEpochMs = Date.now();
      let eosAtMs: number | null = null;
      let speechDurationMs: number | null = null;

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
      const micStartMs = Math.max(0, Math.round(performance.now() - micStartPerf));

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
      eosAtMs = Date.now();
      speechDurationMs =
        state.speechStart != null
          ? Math.max(0, (state.silenceStart ?? eosAtMs) - state.speechStart)
          : null;
      transitionPhase(state, "processing", { turnId });
      setVoiceStatusText(state, "Working on it...");
      void playBackchannelBeep(state).catch(() => undefined);
      onUpdate();

      const audioBlob = await stopRecordingGetAudio(state);
      console.log("[Voice] Audio blob size:", audioBlob?.size ?? 0);

      const firstSpeechMs =
        state.speechStart != null ? Math.max(0, state.speechStart - micStartEpochMs) : undefined;

      if (!audioBlob || audioBlob.size === 0) {
        console.log("[Voice] No audio recorded, restarting listening");
        state.timings = withTurnTelemetry(null, {
          micStartMs,
          firstSpeechMs,
          totalMs: Math.max(0, Date.now() - turnStartedAt),
        });
        transitionPhase(state, "listening", { turnId });
        state.speechDetected = false;
        continue;
      }

      console.log("[Voice] Processing audio...");
      const base64 = await audioToBase64(audioBlob);
      state.audioChunks = [];
      const format = audioBlob.type.toLowerCase().includes("wav") ? "wav" : "webm";

      const result = await onProcess({
        audioBase64: base64,
        format,
        signal: turnAbortController.signal,
        conversationId: state.conversationId ?? ensureConversationId(state),
        turnId,
        clientMessageId,
      });
      const totalMs = Math.max(0, Date.now() - turnStartedAt);
      state.timings = withTurnTelemetry(result?.timings, {
        micStartMs,
        firstSpeechMs,
        totalMs,
      });
      console.info("[Voice/Telemetry] turn", state.timings);
      if (result) {
        result.timings = state.timings;
        markVoiceTurnCompleted(state, result.turnId ?? turnId);
      } else {
        markVoiceTurnCompleted(state, turnId);
      }
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
      const playbackChunks =
        Array.isArray(result?.audioChunks) && result.audioChunks.length > 0
          ? result.audioChunks.filter(
              (chunk): chunk is { audioBase64: string; audioFormat?: string } =>
                Boolean(
                  chunk && typeof chunk.audioBase64 === "string" && chunk.audioBase64.length > 0,
                ),
            )
          : result?.audioBase64
            ? [{ audioBase64: result.audioBase64, audioFormat: result.audioFormat }]
            : [];
      if (playbackChunks.length > 0) {
        console.log("[Voice] Playing audio response...");
        transitionPhase(state, "speaking", { turnId });
        onUpdate();

        await startBargeInMonitor(state, () => {
          interrupted = true;
          console.log("[Voice] Barge-in detected, interrupting playback");
          stopPlayback(state);
          transitionPhase(state, "listening", {
            turnId,
            interruptedBy: "barge_in",
          });
        });

        for (const chunk of playbackChunks) {
          if (!state.conversationActive || interrupted) {
            break;
          }
          await playAudioBase64(chunk.audioBase64, state, chunk.audioFormat);
        }
        cleanupInterruptMonitor(state);
        onUpdate();
      }

      if (result && eosAtMs != null) {
        recordVoiceShortTurnSloSample(state, {
          turnId: result.turnId ?? turnId,
          eosAtMs,
          speechDurationMs,
          outputText: result.response,
        });
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
      transitionPhase(state, "listening", { turnId });
      state.speechDetected = false;
      state.silenceStart = null;
      state.speechStart = null;
      onUpdate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        !state.conversationActive ||
        message === "VOICE_TURN_ABORTED" ||
        message === "request aborted"
      ) {
        state.error = null;
        if (!state.conversationActive) {
          transitionPhase(state, "idle", { turnId, interruptedBy: "user_stop" });
          onUpdate();
          break;
        }
        if (state.phase === "paused_text_run" || state.phase === "approval_wait") {
          onUpdate();
          await waitForConversationResume();
          continue;
        }
        transitionPhase(state, "listening", { turnId });
        onUpdate();
        continue;
      }
      stopPlayback(state);
      cleanupInterruptMonitor(state);
      state.error = message;
      transitionPhase(state, "error", { turnId });
      onUpdate();
      // Try to continue conversation despite error
      transitionPhase(state, "listening", { turnId });
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      if (state.turnAbortController === turnAbortController) {
        state.turnAbortController = null;
      }
    }
  }

  // Cleanup
  cleanupAudio(state);
  state.conversationActive = false;
  state.currentTurnId = null;
  state.currentClientMessageId = null;
  transitionPhase(state, "idle");
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
  if (!state.conversationActive && state.phase === "idle") {
    return;
  }
  state.manualStopVersion += 1;
  state.conversationActive = false;
  if (state.turnAbortController) {
    state.turnAbortController.abort();
    state.turnAbortController = null;
  }
  cleanupAudio(state);
  state.pausedTextRun = null;
  state.currentTurnId = null;
  state.currentClientMessageId = null;
  transitionPhase(state, "idle", { interruptedBy: "user_stop" });
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
