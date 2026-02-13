import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, GatewayResponder } from "./types.js";

const mocks = vi.hoisted(() => ({
  processTextToVoice: vi.fn(),
  resolveVoiceConfig: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({ voice: { enabled: true } }),
  };
});

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

describe("voice.processText gateway handler", () => {
  beforeEach(() => {
    mocks.resolveVoiceConfig.mockReset();
    mocks.processTextToVoice.mockReset();
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
});
