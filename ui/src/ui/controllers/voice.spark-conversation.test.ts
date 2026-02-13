import { describe, expect, it, vi } from "vitest";
import { createVoiceState, processVoiceInputSpark } from "./voice.ts";

describe("processVoiceInputSpark", () => {
  it("runs STT -> voice.processText(skipTts) -> Spark TTS sequence", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        expect(params).toMatchObject({ audio_base64: "audio64", format: "webm" });
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        expect(params).toMatchObject({
          text: "hello world",
          sessionKey: "agent:main:main",
          driveOpenClaw: true,
          skipTts: true,
        });
        return {
          sessionId: "voice-session",
          response: "assistant reply",
          route: "cloud",
          model: "openai-codex/gpt-5.3-codex",
          thinkingLevel: "medium",
          runId: "run-1",
        };
      }
      if (method === "spark.voice.tts") {
        expect(params).toMatchObject({ text: "assistant reply", format: "webm" });
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;
    state.sessionKey = "agent:main:main";
    state.driveOpenClaw = true;

    const result = await processVoiceInputSpark(state, "audio64");

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stt",
      "voice.processText",
      "spark.voice.tts",
    ]);
    expect(result).toMatchObject({
      transcription: "hello world",
      response: "assistant reply",
      audioBase64: "tts64",
      audioFormat: "webm",
      route: "cloud",
      model: "openai-codex/gpt-5.3-codex",
      runId: "run-1",
    });
  });

  it("skips Spark TTS when reply text is empty", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "" };
      }
      if (method === "spark.voice.tts") {
        throw new Error("spark.voice.tts should not be called when response is empty");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64");

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stt",
      "voice.processText",
    ]);
    expect(result?.audioBase64).toBeUndefined();
  });
});
