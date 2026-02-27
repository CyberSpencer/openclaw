import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, GatewayResponder } from "./types.js";

const mocks = vi.hoisted(() => ({
  processTextToVoice: vi.fn(),
  resolveVoiceConfig: vi.fn(),
  updateSessionStore: vi.fn(),
  loadSessionEntry: vi.fn(),
  dispatchInboundMessage: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({ voice: { enabled: true } }),
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: mocks.dispatchInboundMessage,
}));

vi.mock("../../voice/voice.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../voice/voice.js")>("../../voice/voice.js");
  return {
    ...actual,
    resolveVoiceConfig: mocks.resolveVoiceConfig,
    processTextToVoice: mocks.processTextToVoice,
    checkVoiceCapabilities: vi.fn(),
    processVoiceInput: vi.fn(),
  };
});

import { voiceHandlers } from "./voice.js";

function makeInvocation(respond: GatewayResponder, params: Record<string, unknown>) {
  return {
    req: { type: "req", id: "1", method: "voice.processText", params },
    params,
    respond,
    client: null,
    context: {
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      agentRunSeq: new Map(),
      logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as GatewayRequestContext,
    isWebchatConnect: () => false,
  };
}

const fakeStore: Record<string, Record<string, unknown>> = {};

describe("voice.processText gateway handler", () => {
  beforeEach(() => {
    mocks.resolveVoiceConfig.mockReset();
    mocks.processTextToVoice.mockReset();
    mocks.updateSessionStore.mockReset();
    mocks.loadSessionEntry.mockReset();
    mocks.dispatchInboundMessage.mockReset();

    fakeStore["agent:main:main"] = {
      sessionId: "session-main",
      modelOverride: "anthropic/claude-sonnet-4-5",
      updatedAt: Date.now(),
    };

    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      entry: fakeStore["agent:main:main"],
    }));
    mocks.updateSessionStore.mockImplementation(async (_path: string, updater: unknown) => {
      await (updater as (store: Record<string, unknown>) => Promise<void>)(
        fakeStore as unknown as Record<string, unknown>,
      );
    });
    mocks.dispatchInboundMessage.mockResolvedValue(undefined);

    mocks.resolveVoiceConfig.mockReturnValue({
      enabled: true,
      mode: "spark",
    });
    mocks.processTextToVoice.mockResolvedValue({
      success: true,
      sessionId: "s-1",
      transcription: "hello",
      response: "world",
      timings: { totalMs: 10 },
      routerDecision: { route: "local", model: "ollama/test" },
    });
  });

  it("forwards skipTts and applies driveOpenClaw config parity", async () => {
    const respond = vi.fn<GatewayResponder>();

    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, {
        text: "hello",
        driveOpenClaw: true,
        skipTts: true,
      }),
    );

    expect(mocks.processTextToVoice).toHaveBeenCalledTimes(1);
    expect(mocks.processTextToVoice).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ mode: "option2a", enabled: true }),
      expect.any(Function),
      expect.objectContaining({ skipTts: true }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ response: "world", sessionId: "s-1" }),
    );
  });

  it("defaults skipTts false and keeps base config without driveOpenClaw", async () => {
    const respond = vi.fn<GatewayResponder>();

    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(mocks.processTextToVoice).toHaveBeenCalledTimes(1);
    expect(mocks.processTextToVoice).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ mode: "spark", enabled: true }),
      expect.any(Function),
      expect.objectContaining({ skipTts: false }),
    );
  });

  it("applies and restores temporary model override during llm invoke", async () => {
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("hello", "openai-codex/gpt-5.3-codex", "medium");
      return {
        success: true,
        sessionId: "s-2",
        response: "",
        timings: { totalMs: 5 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(2);
    expect(fakeStore["agent:main:main"]?.modelOverride).toBe("anthropic/claude-sonnet-4-5");
  });

  it("reports the actual selected model over router fallback model", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as {
        replyOptions?: {
          onModelSelected?: (ctx: { provider: string; model: string; thinkLevel?: string }) => void;
        };
      };
      typed.replyOptions?.onModelSelected?.({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        thinkLevel: "medium",
      });
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("hello", "openai-codex/gpt-5.3-codex", "medium");
      return {
        success: true,
        sessionId: "s-3",
        response: "done",
        timings: { totalMs: 5 },
        routerDecision: { route: "local", model: "ollama/should-not-surface" },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ model: "openai-codex/gpt-5.3-codex", thinkingLevel: "medium" }),
    );
  });

  it("normalizes conversational thinking to low for short_turn_fast no-tools runs", async () => {
    let commandBody = "";
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as { ctx?: { CommandBody?: string } };
      commandBody = typed.ctx?.CommandBody ?? "";
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("hello", "openai-codex/gpt-5.3-codex", "none");
      return {
        success: true,
        sessionId: "s-fast",
        response: "done",
        timings: { totalMs: 5 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, {
        text: "hello",
        allowTools: false,
        latencyProfile: "short_turn_fast",
      }),
    );

    expect(commandBody.startsWith("/think low ")).toBe(true);
    expect(commandBody.includes("/think none")).toBe(false);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        thinkingLevel: "low",
      }),
    );
  });

  it("preserves higher thinking for tool-capable turns", async () => {
    let commandBody = "";
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as { ctx?: { CommandBody?: string } };
      commandBody = typed.ctx?.CommandBody ?? "";
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("go do the work", "openai-codex/gpt-5.3-codex", "high");
      return {
        success: true,
        sessionId: "s-tools",
        response: "working",
        timings: { totalMs: 5 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, {
        text: "go do the work",
        allowTools: true,
      }),
    );

    expect(commandBody.startsWith("/think high ")).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        thinkingLevel: "high",
      }),
    );
  });

  it("uses clientMessageId for message identity and echoes transcript reconciliation metadata", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async () => undefined);
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("hello");
      return {
        success: true,
        sessionId: "s-4",
        response: "This is the full answer. It has more detail.",
        timings: { totalMs: 5 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, {
        text: "hello",
        skipTts: true,
        conversationId: "voice-conv-1",
        turnId: "voice-turn-1",
        clientMessageId: "voice-msg-1",
        source: "voice",
        spokenOutputMode: "concise",
      }),
    );

    expect(mocks.dispatchInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MessageSid: "voice-msg-1",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        conversationId: "voice-conv-1",
        turnId: "voice-turn-1",
        clientMessageId: "voice-msg-1",
        source: "voice",
        userTranscriptMessageId: "voice-msg-1",
        spokenResponse: expect.any(String),
        userTranscriptMessage: expect.objectContaining({
          id: "voice-msg-1",
          role: "user",
          source: "voice",
        }),
      }),
    );
  });

  it("returns llmFirstSemanticMs and llmFullCompletionMs timing fields", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as {
        dispatcher: { sendFinalReply: (payload: { text: string }) => boolean };
      };
      typed.dispatcher.sendFinalReply({ text: "quick answer" });
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      const response = await llmInvoke("hello", "openai-codex/gpt-5.3-codex", "low");
      return {
        success: true,
        sessionId: "s-5",
        response,
        timings: { totalMs: 20, llmMs: 12 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        response: "quick answer",
        timings: expect.objectContaining({
          llmMs: 12,
          llmFullCompletionMs: 12,
          llmFirstSemanticMs: expect.any(Number),
        }),
      }),
    );
  });

  it("keeps provisional replies ephemeral and disables tools by default", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as {
        dispatcher: { sendFinalReply: (payload: { text: string }) => boolean };
        replyOptions?: { disableBlockStreaming?: boolean; skillFilter?: string[] };
      };
      expect(typed.replyOptions?.disableBlockStreaming).toBe(false);
      expect(typed.replyOptions?.skillFilter).toEqual([]);
      typed.dispatcher.sendFinalReply({ text: "fast provisional reply" });
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      const response = await llmInvoke("hello");
      return {
        success: true,
        sessionId: "s-6",
        response,
        timings: { totalMs: 8, llmMs: 6 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, {
        text: "hello",
        skipTts: true,
        provisional: true,
        source: "voice",
        clientMessageId: "voice-msg-prov-1",
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        response: "fast provisional reply",
        provisional: true,
        userTranscriptMessageId: undefined,
        userTranscriptMessage: null,
      }),
    );
  });

  it("includes toolActivity when tool output is observed during canonical run", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as {
        dispatcher: {
          sendToolResult: (payload: { text: string }) => boolean;
          sendFinalReply: (payload: { text: string }) => boolean;
        };
      };
      typed.dispatcher.sendToolResult({ text: "running tool..." });
      typed.dispatcher.sendFinalReply({ text: "completed" });
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      const response = await llmInvoke("hello");
      return {
        success: true,
        sessionId: "s-7",
        response,
        timings: { totalMs: 10, llmMs: 7 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        toolActivity: true,
      }),
    );
  });

  it("returns interim status text when tool activity is observed without final reply text", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as {
        dispatcher: {
          sendToolResult: (payload: { text: string }) => boolean;
        };
      };
      typed.dispatcher.sendToolResult({ text: "running tool..." });
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      const response = await llmInvoke("send that update");
      return {
        success: true,
        sessionId: "s-8",
        response,
        timings: { totalMs: 9, llmMs: 6 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(
      makeInvocation(respond, { text: "send that update" }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        response: "Working on that action now.",
        toolActivity: true,
      }),
    );
  });

  it("returns non-empty fallback text when no tool/final reply text is emitted", async () => {
    mocks.dispatchInboundMessage.mockImplementationOnce(async () => undefined);
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      const response = await llmInvoke("hello");
      return {
        success: true,
        sessionId: "s-9",
        response,
        timings: { totalMs: 11, llmMs: 8 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    await voiceHandlers["voice.processText"]?.(makeInvocation(respond, { text: "hello" }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        response: "Still working on that. Please try again in a moment.",
      }),
    );
  });
});
