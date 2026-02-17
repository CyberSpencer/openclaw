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

        const trimmed = text.trim();
        const injectThinking = Boolean(thinking && trimmed && !trimmed.startsWith("/"));
        const commandBody = injectThinking ? `/think ${thinking} ${text}` : text;

        const ctx: MsgContext = {
          Body: text,
          BodyForAgent: text,
          BodyForCommands: commandBody,
          RawBody: text,
          CommandBody: commandBody,
          SessionKey: sessionKey,
          Provider: INTERNAL_MESSAGE_CHANNEL,
          Surface: INTERNAL_MESSAGE_CHANNEL,
          OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
          ChatType: "direct",
          CommandAuthorized: true,
          MessageSid: runId,
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
                onAgentRunStart: (agentRunId) => {
                  agentRunStarted = true;
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (connId && wantsToolEvents) {
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

        return combinedReply;
      };

      const result = await processVoiceInput(audioBuffer, config, llmInvoke);

      if (result.success) {
        respond(true, {
          sessionId: result.sessionId,
          transcription: result.transcription,
          response: result.response,
          audioBase64: result.audioBuffer?.toString("base64"),
          route: result.routerDecision?.route,
          model: selectedModelRef.value
            ? `${selectedModelRef.value.provider}/${selectedModelRef.value.model}`
            : result.routerDecision?.model,
          thinkingLevel: selectedModelRef.value?.thinkLevel,
          runId: agentRunIdRef.value,
          timings: result.timings,
        });
      } else {
        respond(
          false,
          {
            sessionId: result.sessionId,
            transcription: result.transcription,
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

    try {
      const voiceConfig = getVoiceConfig();
      const configBase = resolveVoiceConfig(voiceConfig);
      const config = driveOpenClaw ? { ...configBase, mode: "option2a" as const } : configBase;
      if (!config.enabled) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Voice mode is disabled"));
        return;
      }

      const selectedModelRef: {
        value: { provider: string; model: string; thinkLevel?: string } | null;
      } = { value: null };
      const agentRunIdRef: { value: string | null } = { value: null };

      const llmInvoke = async (
        inputText: string,
        modelOverride?: string,
        thinking?: string,
      ): Promise<string> => {
        const { cfg } = loadSessionEntry(sessionKey);
        const runId = randomUUID();
        agentRunIdRef.value = runId;
        let agentRunStarted = false;

        const trimmed = inputText.trim();
        const injectThinking = Boolean(thinking && trimmed && !trimmed.startsWith("/"));
        const commandBody = injectThinking ? `/think ${thinking} ${inputText}` : inputText;

        const ctx: MsgContext = {
          Body: inputText,
          BodyForAgent: inputText,
          BodyForCommands: commandBody,
          RawBody: inputText,
          CommandBody: commandBody,
          SessionKey: sessionKey,
          Provider: INTERNAL_MESSAGE_CHANNEL,
          Surface: INTERNAL_MESSAGE_CHANNEL,
          OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
          ChatType: "direct",
          CommandAuthorized: true,
          MessageSid: runId,
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
                onAgentRunStart: (agentRunId) => {
                  agentRunStarted = true;
                  const connId = typeof client?.connId === "string" ? client.connId : undefined;
                  const wantsToolEvents = hasGatewayClientCap(
                    client?.connect?.caps,
                    GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                  );
                  if (connId && wantsToolEvents) {
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

        return combinedReply;
      };

      const result = await processTextToVoice(text, config, llmInvoke, { skipTts });

      if (result.success) {
        respond(true, {
          sessionId: result.sessionId,
          transcription: result.transcription,
          response: result.response,
          audioBase64: result.audioBuffer?.toString("base64"),
          route: result.routerDecision?.route,
          model: selectedModelRef.value
            ? `${selectedModelRef.value.provider}/${selectedModelRef.value.model}`
            : result.routerDecision?.model,
          thinkingLevel: selectedModelRef.value?.thinkLevel,
          runId: agentRunIdRef.value,
          timings: result.timings,
        });
      } else {
        respond(
          false,
          { sessionId: result.sessionId, timings: result.timings },
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
