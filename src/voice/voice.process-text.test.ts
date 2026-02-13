import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ttsMocks = vi.hoisted(() => ({
  synthesizeWithLocalTts: vi.fn(),
  synthesizeWithMacos: vi.fn(),
}));

vi.mock("./local-tts.js", async () => {
  const actual = await vi.importActual<typeof import("./local-tts.js")>("./local-tts.js");
  return {
    ...actual,
    synthesizeWithLocalTts: ttsMocks.synthesizeWithLocalTts,
    synthesizeWithMacos: ttsMocks.synthesizeWithMacos,
  };
});

import { processTextToVoice, resolveVoiceConfig } from "./voice.js";

const BASE_ENV = { ...process.env };

describe("processTextToVoice", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV, OPENCLAW_OFFLINE: "1" };
    ttsMocks.synthesizeWithLocalTts.mockReset();
    ttsMocks.synthesizeWithMacos.mockReset();
    ttsMocks.synthesizeWithLocalTts.mockResolvedValue({
      success: true,
      provider: "sag",
      audioBuffer: Buffer.from("local"),
    });
    ttsMocks.synthesizeWithMacos.mockResolvedValue({
      success: true,
      provider: "macos",
      audioBuffer: Buffer.from("macos"),
    });
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
  });

  it("skips local TTS when skipTts is true", async () => {
    const config = resolveVoiceConfig({
      enabled: true,
      mode: "spark",
      ttsProvider: "macos",
      router: {
        mode: "local",
        localModel: "ollama/nemotron-3-nano:30b",
      },
    });

    const llmInvoke = vi.fn(async () => "assistant response");
    const result = await processTextToVoice("hello", config, llmInvoke, { skipTts: true });

    expect(result.success).toBe(true);
    expect(result.response).toBe("assistant response");
    expect(result.audioBuffer).toBeUndefined();
    expect(result.timings?.ttsMs).toBeUndefined();
    expect(ttsMocks.synthesizeWithLocalTts).not.toHaveBeenCalled();
    expect(ttsMocks.synthesizeWithMacos).not.toHaveBeenCalled();
  });

  it("runs configured local TTS when skipTts is false", async () => {
    const config = resolveVoiceConfig({
      enabled: true,
      mode: "spark",
      ttsProvider: "macos",
      router: {
        mode: "local",
        localModel: "ollama/nemotron-3-nano:30b",
      },
    });

    const llmInvoke = vi.fn(async () => "assistant response");
    const result = await processTextToVoice("hello", config, llmInvoke);

    expect(result.success).toBe(true);
    expect(result.audioBuffer).toEqual(Buffer.from("macos"));
    expect(ttsMocks.synthesizeWithMacos).toHaveBeenCalledTimes(1);
  });
});
