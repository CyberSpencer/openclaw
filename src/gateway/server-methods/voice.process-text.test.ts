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

  it("registers tool-event recipients when the client advertises tool-events", async () => {
    const registerToolEventRecipient = vi.fn();

    mocks.dispatchInboundMessage.mockImplementationOnce(async (arg: unknown) => {
      const typed = arg as { replyOptions?: { onAgentRunStart?: (runId: string) => void } };
      typed.replyOptions?.onAgentRunStart?.("run-123");
    });
    mocks.processTextToVoice.mockImplementationOnce(async (_text, _config, llmInvoke) => {
      await llmInvoke("hello");
      return {
        success: true,
        sessionId: "s-4",
        response: "",
        timings: { totalMs: 5 },
      };
    });

    const respond = vi.fn<GatewayResponder>();
    const base = makeInvocation(respond, { text: "hello" });
    await voiceHandlers["voice.processText"]?.({
      ...base,
      client: {
        connId: "c-1",
        connect: { caps: ["tool-events"] },
      },
      context: {
        ...base.context,
        registerToolEventRecipient,
      } as unknown as GatewayRequestContext,
    });

    expect(registerToolEventRecipient).toHaveBeenCalledTimes(1);
    expect(registerToolEventRecipient).toHaveBeenCalledWith("run-123", "c-1");
  });
});
