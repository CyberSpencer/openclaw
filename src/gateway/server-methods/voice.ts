/**
 * Voice mode WebSocket handlers for the gateway.
 *
 * Provides real-time voice interaction endpoints:
 * - voice.status: Check voice capabilities
 * - voice.config: Get/set voice configuration
 * - voice.process: Process audio through full pipeline
 * - voice.processText: Process text (skip STT)
 * - voice.transcribe: STT only
 * - voice.synthesize: TTS only
 */

import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { VoiceConfig } from "../../config/types.voice.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { transcribeWithWhisper, resolveWhisperConfig } from "../../voice/local-stt.js";
import { synthesizeWithLocalTts, resolveLocalTtsConfig } from "../../voice/local-tts.js";
import {
  resolvePersonaPlexConfig,
  selectPersonaPlexEndpoint,
  startPersonaPlexServer,
  stopPersonaPlexServer,
  processWithPersonaPlex,
  getPersonaPlexStatus,
} from "../../voice/personaplex.js";
import { routeVoiceRequest, resolveRouterConfig } from "../../voice/router.js";
import {
  resolveVoiceConfig,
  checkVoiceCapabilities,
  processVoiceInput,
  processTextToVoice,
} from "../../voice/voice.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";

/**
 * Get voice configuration from OpenClaw config.
 */
function getVoiceConfig(): VoiceConfig {
  const cfg = loadConfig();
  return cfg.voice ?? {};
}

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];
type VoiceSource = "voice";
type SpokenOutputMode = "concise" | "full" | "status";
type VoiceLatencyProfile = "default" | "short_turn_fast";

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): string | null {
  const { sessionId, storePath, sessionFile } = params;
  if (sessionFile) {
    return sessionFile;
  }
  if (!storePath) {
    return null;
  }
  return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const messageBody: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    stopReason: "stop",
    usage,
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
  };

  try {
    const sessionManager = SessionManager.open(transcriptPath);
    const messageId = sessionManager.appendMessage(messageBody);
    return { ok: true, messageId, message: messageBody };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function asOptionalVoiceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function asVoiceSource(value: unknown): VoiceSource | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "voice" ? "voice" : undefined;
}

function asSpokenOutputMode(value: unknown): SpokenOutputMode {
  if (value === "full" || value === "status") {
    return value;
  }
  return "concise";
}

function asVoiceLatencyProfile(value: unknown): VoiceLatencyProfile {
  return value === "short_turn_fast" ? "short_turn_fast" : "default";
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalMaxOutputTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.max(1, Math.trunc(value));
  return Math.min(1024, normalized);
}

type RuntimeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeRuntimeThinkingLevel(value: unknown): RuntimeThinkingLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "none") {
    return "off";
  }
  switch (normalized) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    default:
      return undefined;
  }
}

function resolveVoiceThinkingLevel(params: {
  allowTools: boolean;
  latencyProfile: VoiceLatencyProfile;
  configuredThinking: unknown;
  routedThinking: unknown;
}): RuntimeThinkingLevel | undefined {
  const configured = normalizeRuntimeThinkingLevel(params.configuredThinking);
  const routed = normalizeRuntimeThinkingLevel(params.routedThinking);

  if (params.allowTools) {
    // Tool-capable runs should preserve full reasoning depth by default.
    return routed;
  }

  if (configured) {
    return configured;
  }

  // Conversation-only lane defaults to low thinking for responsiveness.
  if (params.latencyProfile === "short_turn_fast") {
    return "low";
  }

  // Preserve routed value when valid, otherwise fail safe to low for conversational mode.
  return routed ?? "low";
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  // Heuristic for English-ish text/tokenization.
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function truncateToTokenBudget(text: string, maxTokens?: number): string {
  if (!maxTokens || maxTokens <= 0) {
    return text;
  }
  const normalized = text.trim();
  if (!normalized) {
    return normalized;
  }
  if (estimateTokenCount(normalized) <= maxTokens) {
    return normalized;
  }
  const approxChars = Math.max(12, maxTokens * 4);
  const sliced = normalized.slice(0, approxChars);
  const boundary = sliced.lastIndexOf(" ");
  const safe = (boundary > 24 ? sliced.slice(0, boundary) : sliced).trimEnd();
  return safe ? `${safe}...` : normalized;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const sliced = text.slice(0, maxChars - 3).trimEnd();
  return `${sliced}...`;
}

function deriveSpokenResponse(text: string, mode: SpokenOutputMode): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (mode === "full") {
    return normalized;
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const firstSentence = sentences[0] ?? normalized;
  if (mode === "status") {
    return truncateText(firstSentence, 96);
  }

  const concise = sentences.length > 1 ? `${sentences[0]} ${sentences[1]}` : firstSentence;
  return truncateText(concise, 220);
}

type VoiceAdaptiveTurn = {
  user: string;
  assistant: string;
  allowTools: boolean;
  timestamp: number;
};

type VoiceAdaptiveState = {
  turns: VoiceAdaptiveTurn[];
  pinnedFacts: string[];
  rollingSummary: string;
  updatedAt: number;
};

const VOICE_ADAPTIVE_STATE = new Map<string, VoiceAdaptiveState>();
const VOICE_ADAPTIVE_MAX_TURNS = 18;
const VOICE_ADAPTIVE_MAX_PINNED_FACTS = 10;
const VOICE_ADAPTIVE_SUMMARY_TURNS = 4;

function compactVoiceText(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function shouldRehydrateVoiceContext(text: string): boolean {
  if (!text) {
    return false;
  }
  return /\b(earlier|previously|as we said|as discussed|that number|that deadline|recap|remind me|what did we decide)\b/i.test(
    text,
  );
}

function extractPinnedFacts(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  const candidates = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      return (
        /\d/.test(part) ||
        /\b(deadline|due|budget|price|cost|must|cannot|can't|always|never|ship|before|after|today|tomorrow|next week|priority|critical)\b/i.test(
          part,
        )
      );
    })
    .map((part) => compactVoiceText(part, 160));
  return Array.from(new Set(candidates)).slice(0, 4);
}

function buildRollingVoiceSummary(turns: VoiceAdaptiveTurn[]): string {
  const relevant = turns.slice(-VOICE_ADAPTIVE_SUMMARY_TURNS);
  if (relevant.length === 0) {
    return "";
  }
  return relevant
    .map((turn, idx) => {
      const user = compactVoiceText(turn.user, 110);
      const assistant = compactVoiceText(turn.assistant, 110);
      return `${idx + 1}) U: ${user}\n   J: ${assistant}`;
    })
    .join("\n");
}

function getVoiceAdaptiveState(sessionKey: string): VoiceAdaptiveState {
  const existing = VOICE_ADAPTIVE_STATE.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: VoiceAdaptiveState = {
    turns: [],
    pinnedFacts: [],
    rollingSummary: "",
    updatedAt: Date.now(),
  };
  VOICE_ADAPTIVE_STATE.set(sessionKey, created);
  return created;
}

function updateVoiceAdaptiveState(params: {
  sessionKey: string;
  userText: string;
  assistantText: string;
  allowTools: boolean;
}): void {
  const userText = compactVoiceText(params.userText, 220);
  const assistantText = compactVoiceText(params.assistantText, 220);
  if (!userText || !assistantText) {
    return;
  }

  const state = getVoiceAdaptiveState(params.sessionKey);
  state.turns.push({
    user: userText,
    assistant: assistantText,
    allowTools: params.allowTools,
    timestamp: Date.now(),
  });
  if (state.turns.length > VOICE_ADAPTIVE_MAX_TURNS) {
    state.turns = state.turns.slice(-VOICE_ADAPTIVE_MAX_TURNS);
  }

  const factCandidates = extractPinnedFacts(params.userText);
  if (factCandidates.length) {
    const merged = [...state.pinnedFacts, ...factCandidates].map((fact) =>
      compactVoiceText(fact, 140),
    );
    state.pinnedFacts = Array.from(new Set(merged)).slice(-VOICE_ADAPTIVE_MAX_PINNED_FACTS);
  }

  state.rollingSummary = buildRollingVoiceSummary(state.turns);
  state.updatedAt = Date.now();
}

function buildVoiceAdaptiveContextPrefix(params: {
  sessionKey: string;
  includeRecentTurns: boolean;
  allowTools: boolean;
}): string {
  const state = VOICE_ADAPTIVE_STATE.get(params.sessionKey);
  if (!state) {
    return "";
  }

  const sections: string[] = [];

  if (state.rollingSummary) {
    sections.push(`Rolling summary:\n${state.rollingSummary}`);
  }

  if (state.pinnedFacts.length) {
    sections.push(`Pinned facts:\n${state.pinnedFacts.map((fact) => `- ${fact}`).join("\n")}`);
  }

  if (params.includeRecentTurns) {
    const recentTurns = state.turns.slice(params.allowTools ? -6 : -3);
    if (recentTurns.length) {
      const rendered = recentTurns
        .map((turn, idx) => {
          return `${idx + 1}) U: ${compactVoiceText(turn.user, 90)}\n   J: ${compactVoiceText(turn.assistant, 90)}`;
        })
        .join("\n");
      sections.push(`Recent context:\n${rendered}`);
    }
  }

  if (sections.length === 0) {
    return "";
  }

  const contextBlock = `Conversation context to preserve continuity and constraints:\n${sections.join("\n\n")}`;
  const tokenBudget = params.allowTools ? 360 : 220;
  return truncateToTokenBudget(contextBlock, tokenBudget);
}

function applyVoiceLatencyProfile<T extends { router?: Record<string, unknown> }>(
  config: T,
  latencyProfile: VoiceLatencyProfile,
): T {
  if (latencyProfile !== "short_turn_fast") {
    return config;
  }
  if (!config.router || typeof config.router !== "object") {
    return config;
  }
  return {
    ...config,
    router: {
      ...config.router,
      mode: "local",
      useComplexity: false,
      complexityThreshold: 10,
    },
  };
}

function buildVoiceUserTranscriptMessage(params: {
  messageId: string;
  text: string;
  conversationId?: string;
  turnId?: string;
  source?: VoiceSource;
}): Record<string, unknown> {
  const message: Record<string, unknown> = {
    id: params.messageId,
    role: "user",
    source: params.source ?? "voice",
    content: [{ type: "text", text: params.text }],
    timestamp: Date.now(),
  };
  if (params.conversationId) {
    message.conversationId = params.conversationId;
  }
  if (params.turnId) {
    message.turnId = params.turnId;
  }
  return message;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: {
    broadcast: (event: string, payload: unknown) => void;
    nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
    agentRunSeq: Map<string, number>;
  };
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: params.message,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastVoiceUserTranscript(params: {
  context: {
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  };
  sessionKey: string;
  conversationId?: string;
  turnId?: string;
  clientMessageId: string;
  source?: VoiceSource;
  message: Record<string, unknown>;
}) {
  const payload = {
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
    turnId: params.turnId,
    clientMessageId: params.clientMessageId,
    source: params.source ?? "voice",
    message: params.message,
    messageId:
      typeof params.message.id === "string" && params.message.id.trim()
        ? params.message.id.trim()
        : params.clientMessageId,
  };
  params.context.broadcast("voice.transcript.user", payload, { dropIfSlow: true });
  params.context.nodeSendToSession(params.sessionKey, "voice.transcript.user", payload);
}

async function withTemporaryVoiceModelOverride<T>(params: {
  sessionKey: string;
  model?: string;
  run: () => Promise<T>;
  onWarn?: (message: string) => void;
}): Promise<T> {
  const requestedModel = typeof params.model === "string" ? params.model.trim() : "";
  if (!requestedModel) {
    return params.run();
  }

  const { storePath, canonicalKey, entry } = loadSessionEntry(params.sessionKey);
  if (!storePath || !canonicalKey) {
    return params.run();
  }

  const previousModel = typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
  if (previousModel === requestedModel) {
    return params.run();
  }
  const fallbackSessionId = entry?.sessionId ?? canonicalKey;

  try {
    await updateSessionStore(storePath, async (store) => {
      const rawCurrent = (store[canonicalKey] as Record<string, unknown> | undefined) ?? {};
      const current = rawCurrent && typeof rawCurrent === "object" ? rawCurrent : {};
      store[canonicalKey] = {
        ...current,
        sessionId:
          typeof current.sessionId === "string" && current.sessionId.trim()
            ? current.sessionId
            : fallbackSessionId,
        modelOverride: requestedModel,
        updatedAt: Date.now(),
      };
    });
  } catch (err) {
    params.onWarn?.(`voice model override set failed: ${formatForLog(err)}`);
    return params.run();
  }

  try {
    return await params.run();
  } finally {
    try {
      await updateSessionStore(storePath, async (store) => {
        const rawCurrent = (store[canonicalKey] as Record<string, unknown> | undefined) ?? {};
        const current = rawCurrent && typeof rawCurrent === "object" ? rawCurrent : {};
        const currentModel =
          typeof current.modelOverride === "string" ? current.modelOverride.trim() : "";

        // Avoid clobbering a newer concurrent change by another flow.
        if (currentModel !== requestedModel) {
          return;
        }

        const next: Record<string, unknown> = {
          ...current,
          sessionId:
            typeof current.sessionId === "string" && current.sessionId.trim()
              ? current.sessionId
              : fallbackSessionId,
          updatedAt: Date.now(),
        };
        if (previousModel) {
          next.modelOverride = previousModel;
        } else {
          delete next.modelOverride;
        }
        store[canonicalKey] = next as SessionEntry;
      });
    } catch (err) {
      params.onWarn?.(`voice model override restore failed: ${formatForLog(err)}`);
    }
  }
}

export const voiceHandlers: GatewayRequestHandlers = {
  /**
   * Get voice mode status and capabilities.
   */
  "voice.status": async ({ respond }) => {
    try {
      const voiceConfig = getVoiceConfig();
      const config = resolveVoiceConfig(voiceConfig);
      const capabilities = await checkVoiceCapabilities(config);

      respond(true, {
        enabled: config.enabled,
        mode: config.mode,
        sttProvider: config.sttProvider,
        ttsProvider: config.ttsProvider,
        capabilities,
        streaming: config.streaming,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Get voice configuration.
   */
  "voice.config": async ({ respond }) => {
    try {
      const voiceConfig = getVoiceConfig();
      const config = resolveVoiceConfig(voiceConfig);

      respond(true, {
        mode: config.mode,
        enabled: config.enabled,
        sttProvider: config.sttProvider,
        ttsProvider: config.ttsProvider,
        whisper: {
          modelPath: config.whisper.modelPath,
          language: config.whisper.language,
          threads: config.whisper.threads,
        },
        localTts: {
          useSag: config.localTts.useSag,
          voiceId: config.localTts.voiceId,
          fallbackToMacos: config.localTts.fallbackToMacos,
        },
        router: {
          mode: config.router.mode,
          detectSensitive: config.router.detectSensitive,
          useComplexity: config.router.useComplexity,
          localModel: config.router.localModel,
          cloudModel: config.router.cloudModel,
          complexityThreshold: config.router.complexityThreshold,
        },
        personaplex: {
          enabled: config.personaplex.enabled,
          port: config.personaplex.port,
          useSsl: config.personaplex.useSsl,
          cpuOffload: config.personaplex.cpuOffload,
          idleTimeoutMs: config.personaplex.idleTimeoutMs,
          voicePrompt: config.personaplex.voicePrompt,
          textPrompt: config.personaplex.textPrompt,
          seed: config.personaplex.seed,
        },
        streaming: config.streaming,
        bufferMs: config.bufferMs,
        maxRecordingSeconds: config.maxRecordingSeconds,
        vadSensitivity: config.vadSensitivity,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Process audio through full voice pipeline (STT -> Route -> LLM -> TTS).
   *
   * Params:
   * - audio: Base64-encoded audio data (WAV format)
   * - sessionKey: Optional session key for chat context
   */
  "voice.process": async ({ params, respond, context, client }) => {
    const audioBase64 = typeof params.audio === "string" ? params.audio : "";
    if (!audioBase64) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.process requires audio (base64)"),
      );
      return;
    }

    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "webchat-voice";
    const textPrompt = typeof params.textPrompt === "string" ? params.textPrompt.trim() : "";
    const voicePrompt = typeof params.voicePrompt === "string" ? params.voicePrompt.trim() : "";
    const driveOpenClaw = params.driveOpenClaw === true;
    const seed =
      typeof params.seed === "number" && Number.isFinite(params.seed)
        ? Math.trunc(params.seed)
        : undefined;
    const cpuOffload = typeof params.cpuOffload === "boolean" ? params.cpuOffload : undefined;
    const conversationId = asOptionalVoiceId(params.conversationId);
    const turnId = asOptionalVoiceId(params.turnId);
    const clientMessageId = asOptionalVoiceId(params.clientMessageId);
    const source = asVoiceSource(params.source);
    const spokenOutputMode = asSpokenOutputMode(params.spokenOutputMode);
    const allowTools = asOptionalBoolean(params.allowTools) ?? false;

    try {
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const voiceConfig = getVoiceConfig();
      const personaplexOverrides: VoiceConfig["personaplex"] = {
        ...voiceConfig.personaplex,
        ...(textPrompt ? { textPrompt } : {}),
        ...(voicePrompt ? { voicePrompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(cpuOffload !== undefined ? { cpuOffload } : {}),
      };
      const configBase = resolveVoiceConfig({
        ...voiceConfig,
        personaplex: personaplexOverrides,
      });
      const config = driveOpenClaw ? { ...configBase, mode: "option2a" as const } : configBase;
      if (!config.enabled) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Voice mode is disabled"));
        return;
      }

      const selectedModelRef: {
        value: { provider: string; model: string; thinkLevel?: string } | null;
      } = { value: null };
      const appliedThinkingRef: { value: RuntimeThinkingLevel | null } = { value: null };
      const agentRunIdRef: { value: string | null } = { value: null };

      const llmInvoke = async (
        text: string,
        modelOverride?: string,
        thinking?: string,
      ): Promise<string> => {
        const { cfg } = loadSessionEntry(sessionKey);
        const runId = randomUUID();
        agentRunIdRef.value = runId;
        let agentRunStarted = false;

        const rehydrate = shouldRehydrateVoiceContext(text);
        const adaptiveContext = buildVoiceAdaptiveContextPrefix({
          sessionKey,
          includeRecentTurns: allowTools || rehydrate,
          allowTools,
        });
        const contextAwareInput = adaptiveContext
          ? `${adaptiveContext}\n\nCurrent user request:\n${text}`
          : text;

        const promptText = !allowTools
          ? `Respond directly in plain text only. Do not run tools, commands, or external actions.\n\n${contextAwareInput}`
          : contextAwareInput;
        const trimmed = promptText.trim();
        // Conversation lane should stay low-latency, action lane keeps full reasoning depth.
        const effectiveThinking = resolveVoiceThinkingLevel({
          allowTools,
          latencyProfile: "default",
          configuredThinking: voiceConfig.thinkingLevel,
          routedThinking: thinking,
        });
        appliedThinkingRef.value = effectiveThinking ?? null;
        const injectThinking = Boolean(
          effectiveThinking && effectiveThinking !== "off" && trimmed && !trimmed.startsWith("/"),
        );
        const commandBody = injectThinking
          ? `/think ${effectiveThinking} ${promptText}`
          : promptText;

        const ctx: MsgContext = {
          Body: promptText,
          BodyForAgent: promptText,
          BodyForCommands: commandBody,
          RawBody: promptText,
          CommandBody: commandBody,
          SessionKey: sessionKey,
          Provider: INTERNAL_MESSAGE_CHANNEL,
          Surface: INTERNAL_MESSAGE_CHANNEL,
          OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
          ChatType: "direct",
          CommandAuthorized: true,
          MessageSid: clientMessageId ?? runId,
        };

        const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
        let prefixContext: ResponsePrefixContext = {
          identityName: resolveIdentityName(cfg, agentId),
        };
        const finalReplyParts: string[] = [];
        const dispatcher = createReplyDispatcher({
          responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
          responsePrefixContextProvider: () => prefixContext,
          onError: (err) => {
            context.logGateway.warn(`voice dispatch failed: ${formatForLog(err)}`);
          },
          deliver: async (payload, info) => {
            if (info.kind !== "final") {
              return;
            }
            const text = payload.text?.trim() ?? "";
            if (!text) {
              return;
            }
            finalReplyParts.push(text);
          },
        });

        await withTemporaryVoiceModelOverride({
          sessionKey,
          model: modelOverride,
          onWarn: (message) => {
            context.logGateway.warn(message);
          },
          run: async () => {
            await dispatchInboundMessage({
              ctx,
              cfg,
              dispatcher,
              replyOptions: {
                runId,
                disableBlockStreaming: true,
                ...(allowTools ? {} : { skillFilter: [] as string[] }),
                onAgentRunStart: (agentRunId) => {
                  agentRunStarted = true;
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (allowTools && connId && wantsToolEvents) {
                    context.registerToolEventRecipient(agentRunId, connId);
                  }
                },
                onModelSelected: (sel) => {
                  selectedModelRef.value = {
                    provider: sel.provider,
                    model: sel.model,
                    thinkLevel: sel.thinkLevel,
                  };
                  prefixContext.provider = sel.provider;
                  prefixContext.model = extractShortModelName(sel.model);
                  prefixContext.modelFull = `${sel.provider}/${sel.model}`;
                  prefixContext.thinkingLevel = sel.thinkLevel ?? "off";
                },
              },
            });
          },
        });

        const combinedReply = finalReplyParts
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n\n")
          .trim();

        // For command-handled replies (no agent run), ensure the assistant message is persisted
        // and broadcast as a final chat event so the Control UI stays in sync.
        if (!agentRunStarted && combinedReply) {
          const { storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId ?? runId;
          const appended = appendAssistantTranscriptMessage({
            message: combinedReply,
            label: "voice",
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            createIfMissing: true,
          });
          const message =
            appended.ok && appended.message
              ? appended.message
              : {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: Date.now(),
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
          broadcastChatFinal({ context, runId, sessionKey, message });
        }

        updateVoiceAdaptiveState({
          sessionKey,
          userText: text,
          assistantText: combinedReply,
          allowTools,
        });

        return combinedReply;
      };

      const result = await processVoiceInput(audioBuffer, config, llmInvoke);
      const transcriptionText =
        typeof result.transcription === "string" ? result.transcription : "";
      const userTranscriptMessage =
        source === "voice" && clientMessageId && transcriptionText.trim()
          ? buildVoiceUserTranscriptMessage({
              messageId: clientMessageId,
              text: transcriptionText,
              conversationId,
              turnId,
              source,
            })
          : null;
      const spokenResponse = deriveSpokenResponse(result.response ?? "", spokenOutputMode);
      if (userTranscriptMessage && clientMessageId) {
        broadcastVoiceUserTranscript({
          context,
          sessionKey,
          conversationId,
          turnId,
          clientMessageId,
          source,
          message: userTranscriptMessage,
        });
      }

      if (result.success) {
        respond(true, {
          sessionId: result.sessionId,
          transcription: result.transcription,
          response: result.response,
          spokenResponse,
          audioBase64: result.audioBuffer?.toString("base64"),
          route: result.routerDecision?.route,
          model: selectedModelRef.value
            ? `${selectedModelRef.value.provider}/${selectedModelRef.value.model}`
            : result.routerDecision?.model,
          thinkingLevel: appliedThinkingRef.value ?? selectedModelRef.value?.thinkLevel,
          runId: agentRunIdRef.value,
          conversationId,
          turnId,
          clientMessageId,
          source,
          userTranscriptMessageId: userTranscriptMessage ? clientMessageId : undefined,
          userTranscriptMessage,
          timings: result.timings,
        });
      } else {
        respond(
          false,
          {
            sessionId: result.sessionId,
            transcription: result.transcription,
            spokenResponse,
            conversationId,
            turnId,
            clientMessageId,
            source,
            userTranscriptMessageId: userTranscriptMessage ? clientMessageId : undefined,
            userTranscriptMessage,
            timings: result.timings,
          },
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Voice processing failed"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Process text through voice pipeline (skip STT).
   *
   * Params:
   * - text: Text to process
   * - sessionKey: Optional session key for chat context
   * - driveOpenClaw: Optional parity flag with voice.process config shaping
   * - skipTts: Optional flag to return text-only response (no local TTS synthesis)
   */
  "voice.processText": async ({ params, respond, context, client }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.processText requires text"),
      );
      return;
    }

    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "webchat-voice";
    const skipTts = params.skipTts === true;
    const driveOpenClaw = params.driveOpenClaw === true;
    const conversationId = asOptionalVoiceId(params.conversationId);
    const turnId = asOptionalVoiceId(params.turnId);
    const clientMessageId = asOptionalVoiceId(params.clientMessageId);
    const source = asVoiceSource(params.source);
    const spokenOutputMode = asSpokenOutputMode(params.spokenOutputMode);
    const latencyProfile = asVoiceLatencyProfile(params.latencyProfile);
    const provisional = params.provisional === true;
    const allowTools = asOptionalBoolean(params.allowTools) ?? !provisional;
    const maxOutputTokens =
      asOptionalMaxOutputTokens(params.maxOutputTokens) ?? (provisional ? 64 : undefined);

    try {
      const voiceConfig = getVoiceConfig();
      const configBase = resolveVoiceConfig(voiceConfig);
      const profiledConfig = applyVoiceLatencyProfile(configBase, latencyProfile);
      const config = driveOpenClaw
        ? { ...profiledConfig, mode: "option2a" as const }
        : profiledConfig;
      if (!config.enabled) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Voice mode is disabled"));
        return;
      }

      const selectedModelRef: {
        value: { provider: string; model: string; thinkLevel?: string } | null;
      } = { value: null };
      const appliedThinkingRef: { value: RuntimeThinkingLevel | null } = { value: null };
      const agentRunIdRef: { value: string | null } = { value: null };
      const llmInvokeStartedAtRef: { value: number | null } = { value: null };
      const llmFirstSemanticAtRef: { value: number | null } = { value: null };
      const toolReplyObservedRef: { value: boolean } = { value: false };

      const llmInvoke = async (
        inputText: string,
        modelOverride?: string,
        thinking?: string,
      ): Promise<string> => {
        const { cfg } = loadSessionEntry(sessionKey);
        const runId = randomUUID();
        agentRunIdRef.value = runId;
        let agentRunStarted = false;
        llmInvokeStartedAtRef.value = Date.now();

        const rehydrate = shouldRehydrateVoiceContext(inputText);
        const adaptiveContext = buildVoiceAdaptiveContextPrefix({
          sessionKey,
          includeRecentTurns: allowTools || rehydrate,
          allowTools,
        });
        const contextAwareInput = adaptiveContext
          ? `${adaptiveContext}\n\nCurrent user request:\n${inputText}`
          : inputText;

        const promptText = !allowTools
          ? `Respond directly in plain text only. Do not run tools, commands, or external actions.\n\n${contextAwareInput}`
          : contextAwareInput;
        const trimmed = promptText.trim();
        // Use fast-thinking for conversational turns, keep full reasoning for tool-capable action turns.
        const effectiveThinking = resolveVoiceThinkingLevel({
          allowTools,
          latencyProfile,
          configuredThinking: voiceConfig.thinkingLevel,
          routedThinking: thinking,
        });
        appliedThinkingRef.value = effectiveThinking ?? null;
        const injectThinking = Boolean(
          effectiveThinking && effectiveThinking !== "off" && trimmed && !trimmed.startsWith("/"),
        );
        const commandBody = injectThinking
          ? `/think ${effectiveThinking} ${promptText}`
          : promptText;

        const ctx: MsgContext = {
          Body: promptText,
          BodyForAgent: promptText,
          BodyForCommands: commandBody,
          RawBody: promptText,
          CommandBody: commandBody,
          SessionKey: sessionKey,
          Provider: INTERNAL_MESSAGE_CHANNEL,
          Surface: INTERNAL_MESSAGE_CHANNEL,
          OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
          ChatType: "direct",
          CommandAuthorized: true,
          MessageSid: clientMessageId ?? runId,
        };

        const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
        let prefixContext: ResponsePrefixContext = {
          identityName: resolveIdentityName(cfg, agentId),
        };
        const finalReplyParts: string[] = [];
        const blockReplyParts: string[] = [];
        const dispatcher = createReplyDispatcher({
          responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
          responsePrefixContextProvider: () => prefixContext,
          onError: (err) => {
            context.logGateway.warn(`voice dispatch failed: ${formatForLog(err)}`);
          },
          deliver: async (payload, info) => {
            const deliveredText = payload.text?.trim() ?? "";
            if (!deliveredText) {
              return;
            }
            if (llmFirstSemanticAtRef.value == null) {
              llmFirstSemanticAtRef.value = Date.now();
            }
            if (info.kind === "tool") {
              toolReplyObservedRef.value = true;
              return;
            }
            if (info.kind === "final") {
              finalReplyParts.push(deliveredText);
              return;
            }
            blockReplyParts.push(deliveredText);
          },
        });

        await withTemporaryVoiceModelOverride({
          sessionKey,
          model: modelOverride,
          onWarn: (message) => {
            context.logGateway.warn(message);
          },
          run: async () => {
            await dispatchInboundMessage({
              ctx,
              cfg,
              dispatcher,
              replyOptions: {
                runId,
                disableBlockStreaming: !provisional,
                ...(allowTools ? {} : { skillFilter: [] as string[] }),
                onAgentRunStart: (agentRunId) => {
                  agentRunStarted = true;
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (allowTools && connId && wantsToolEvents) {
                    context.registerToolEventRecipient(agentRunId, connId);
                  }
                },
                onModelSelected: (sel) => {
                  selectedModelRef.value = {
                    provider: sel.provider,
                    model: sel.model,
                    thinkLevel: sel.thinkLevel,
                  };
                  prefixContext.provider = sel.provider;
                  prefixContext.model = extractShortModelName(sel.model);
                  prefixContext.modelFull = `${sel.provider}/${sel.model}`;
                  prefixContext.thinkingLevel = sel.thinkLevel ?? "off";
                },
              },
            });
          },
        });

        const combinedReply = finalReplyParts
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n\n")
          .trim();
        const blockReply = blockReplyParts
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n\n")
          .trim();
        let resolvedReply = truncateToTokenBudget(combinedReply || blockReply, maxOutputTokens);
        if (!resolvedReply) {
          if (allowTools && toolReplyObservedRef.value) {
            // Keep voice turns conversational when tool execution begins before a textual summary is emitted.
            resolvedReply = "Working on that action now.";
          } else {
            // Guarantee a spoken fallback so voice turns never return an empty assistant response.
            resolvedReply = "Still working on that. Please try again in a moment.";
          }
        }

        if (!provisional && !agentRunStarted && resolvedReply) {
          const { storePath, entry } = loadSessionEntry(sessionKey);
          const sessionId = entry?.sessionId ?? runId;
          const appended = appendAssistantTranscriptMessage({
            message: resolvedReply,
            label: "voice",
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            createIfMissing: true,
          });
          const message =
            appended.ok && appended.message
              ? appended.message
              : {
                  role: "assistant",
                  content: [{ type: "text", text: resolvedReply }],
                  timestamp: Date.now(),
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
          broadcastChatFinal({ context, runId, sessionKey, message });
        }

        if (toolReplyObservedRef.value && !allowTools) {
          context.logGateway.warn("voice.processText provisional run observed tool output");
        }
        if (!provisional) {
          updateVoiceAdaptiveState({
            sessionKey,
            userText: inputText,
            assistantText: resolvedReply,
            allowTools,
          });
        }
        return resolvedReply;
      };

      const result = await processTextToVoice(text, config, llmInvoke, { skipTts });
      const timingsRecord =
        result.timings && typeof result.timings === "object"
          ? (result.timings as Record<string, unknown>)
          : undefined;
      const llmFullCompletionMsRaw =
        typeof timingsRecord?.llmFullCompletionMs === "number"
          ? timingsRecord.llmFullCompletionMs
          : typeof timingsRecord?.llmMs === "number"
            ? timingsRecord.llmMs
            : undefined;
      const llmFirstSemanticMsRaw =
        llmInvokeStartedAtRef.value != null && llmFirstSemanticAtRef.value != null
          ? Math.max(0, llmFirstSemanticAtRef.value - llmInvokeStartedAtRef.value)
          : undefined;
      const llmFullCompletionMs =
        llmFullCompletionMsRaw != null ? Math.max(0, llmFullCompletionMsRaw) : undefined;
      const llmFirstSemanticMs =
        llmFirstSemanticMsRaw != null
          ? llmFirstSemanticMsRaw
          : llmFullCompletionMs != null
            ? llmFullCompletionMs
            : undefined;
      const resultTimings = {
        ...result.timings,
        ...(llmFullCompletionMs != null ? { llmMs: llmFullCompletionMs } : {}),
        ...(llmFullCompletionMs != null ? { llmFullCompletionMs } : {}),
        ...(llmFirstSemanticMs != null ? { llmFirstSemanticMs } : {}),
      };
      const userTranscriptMessage =
        !provisional && source === "voice" && clientMessageId && text
          ? buildVoiceUserTranscriptMessage({
              messageId: clientMessageId,
              text,
              conversationId,
              turnId,
              source,
            })
          : null;
      const spokenResponse = deriveSpokenResponse(result.response ?? "", spokenOutputMode);
      if (userTranscriptMessage && clientMessageId) {
        broadcastVoiceUserTranscript({
          context,
          sessionKey,
          conversationId,
          turnId,
          clientMessageId,
          source,
          message: userTranscriptMessage,
        });
      }

      if (result.success) {
        respond(true, {
          sessionId: result.sessionId,
          transcription: result.transcription,
          response: result.response,
          spokenResponse,
          audioBase64: result.audioBuffer?.toString("base64"),
          route: result.routerDecision?.route,
          model: selectedModelRef.value
            ? `${selectedModelRef.value.provider}/${selectedModelRef.value.model}`
            : result.routerDecision?.model,
          thinkingLevel: appliedThinkingRef.value ?? selectedModelRef.value?.thinkLevel,
          runId: agentRunIdRef.value,
          conversationId,
          turnId,
          clientMessageId,
          source,
          userTranscriptMessageId: userTranscriptMessage ? clientMessageId : undefined,
          userTranscriptMessage,
          toolActivity: toolReplyObservedRef.value || undefined,
          provisional,
          timings: resultTimings,
        });
      } else {
        respond(
          false,
          {
            sessionId: result.sessionId,
            spokenResponse,
            conversationId,
            turnId,
            clientMessageId,
            source,
            userTranscriptMessageId: userTranscriptMessage ? clientMessageId : undefined,
            userTranscriptMessage,
            toolActivity: toolReplyObservedRef.value || undefined,
            provisional,
            timings: resultTimings,
          },
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Voice processing failed"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Transcribe audio using local STT (whisper-cpp).
   *
   * Params:
   * - audio: Base64-encoded audio data
   */
  "voice.transcribe": async ({ params, respond }) => {
    const audioBase64 = typeof params.audio === "string" ? params.audio : "";
    if (!audioBase64) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.transcribe requires audio (base64)"),
      );
      return;
    }

    try {
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const voiceConfig = getVoiceConfig();
      const config = resolveWhisperConfig(voiceConfig.whisper);

      const result = await transcribeWithWhisper(audioBuffer, config);

      if (result.success) {
        respond(true, {
          text: result.text,
          model: result.model,
          latencyMs: result.latencyMs,
        });
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Transcription failed"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Synthesize speech from text using local TTS.
   *
   * Params:
   * - text: Text to synthesize
   */
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

    try {
      const voiceConfig = getVoiceConfig();
      const config = resolveLocalTtsConfig(voiceConfig.localTts);

      const result = await synthesizeWithLocalTts(text, config);

      if (result.success) {
        respond(true, {
          audioBase64: result.audioBuffer?.toString("base64"),
          audioPath: result.audioPath,
          provider: result.provider,
          latencyMs: result.latencyMs,
          warning: result.warning,
        });
      } else {
        respond(
          false,
          { provider: result.provider },
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Speech synthesis failed"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Route a text query (for testing routing logic).
   *
   * Params:
   * - text: Text to analyze for routing
   */
  "voice.route": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.route requires text"),
      );
      return;
    }

    try {
      const voiceConfig = getVoiceConfig();
      const config = resolveRouterConfig(voiceConfig.router);

      const decision = routeVoiceRequest(text, config);

      respond(true, {
        route: decision.route,
        reason: decision.reason,
        sensitiveDetected: decision.sensitiveDetected,
        complexityScore: decision.complexityScore,
        model: decision.model,
        thinking: decision.thinking,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  // ============================================
  // PersonaPlex S2S (Experimental)
  // ============================================

  /**
   * Get PersonaPlex status.
   */
  "voice.personaplex.status": async ({ respond }) => {
    try {
      const voiceConfig = getVoiceConfig();
      const config = resolvePersonaPlexConfig(voiceConfig.personaplex);

      const status = await getPersonaPlexStatus(config);

      respond(true, {
        enabled: config.enabled,
        installed: status.installed,
        running: status.running,
        device: status.device,
        hasToken: status.hasToken,
        port: config.port,
        idleTimeoutMs: config.idleTimeoutMs,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Start PersonaPlex server.
   */
  "voice.personaplex.start": async ({ respond }) => {
    try {
      const voiceConfig = getVoiceConfig();
      const config = resolvePersonaPlexConfig(voiceConfig.personaplex);

      if (!config.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "PersonaPlex is not enabled"),
        );
        return;
      }

      const result = await startPersonaPlexServer(config);

      if (result.success) {
        respond(true, { ok: true, port: config.port });
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "Failed to start PersonaPlex"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Stop PersonaPlex server.
   */
  "voice.personaplex.stop": async ({ respond }) => {
    try {
      stopPersonaPlexServer();
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  /**
   * Process audio through PersonaPlex S2S.
   *
   * Params:
   * - audio: Base64-encoded audio data
   */
  "voice.personaplex.process": async ({ params, respond }) => {
    const audioBase64 = typeof params.audio === "string" ? params.audio : "";
    if (!audioBase64) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice.personaplex.process requires audio (base64)"),
      );
      return;
    }

    try {
      const voiceConfig = getVoiceConfig();
      const textPrompt = typeof params.textPrompt === "string" ? params.textPrompt.trim() : "";
      const voicePrompt = typeof params.voicePrompt === "string" ? params.voicePrompt.trim() : "";
      const seed =
        typeof params.seed === "number" && Number.isFinite(params.seed)
          ? Math.trunc(params.seed)
          : undefined;
      const cpuOffload = typeof params.cpuOffload === "boolean" ? params.cpuOffload : undefined;
      const config = resolvePersonaPlexConfig({
        ...voiceConfig.personaplex,
        ...(textPrompt ? { textPrompt } : {}),
        ...(voicePrompt ? { voicePrompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(cpuOffload !== undefined ? { cpuOffload } : {}),
      });

      if (!config.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "PersonaPlex is not enabled"),
        );
        return;
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      const selected = await selectPersonaPlexEndpoint(config);
      if (!selected) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "PersonaPlex unavailable (no healthy endpoints)"),
        );
        return;
      }
      const result = await processWithPersonaPlex(audioBuffer, selected.config, selected.transport);

      if (result.success) {
        respond(true, {
          audioBase64: result.audioBuffer?.toString("base64"),
          audioPath: result.audioPath,
          latencyMs: result.latencyMs,
        });
      } else {
        respond(
          false,
          { latencyMs: result.latencyMs },
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "PersonaPlex processing failed"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
