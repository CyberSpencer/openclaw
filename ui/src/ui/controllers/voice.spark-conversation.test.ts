import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceState, processVoiceInputSpark } from "./voice.ts";

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(state.lastRoute).toBe("cloud");
    expect(state.lastModel).toBe("openai-codex/gpt-5.3-codex");
    expect(state.lastThinkingLevel).toBe("medium");
    expect(state.routeModelWarning).toBeNull();
  });

  it("emits warning telemetry when route/model hosting classification mismatches", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const request = vi.fn(async (method: string) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return {
          sessionId: "voice-session",
          response: "assistant reply",
          route: "local",
          model: "openai-codex/gpt-5.3-codex",
          thinkingLevel: "low",
        };
      }
      if (method === "spark.voice.tts") {
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64");

    expect(result?.response).toBe("assistant reply");
    expect(state.routeModelWarning).toContain("route/model mismatch");
    expect(warnSpy).toHaveBeenCalledWith(
      "[voice/attribution]",
      expect.objectContaining({
        event: "route_model_mismatch",
        route: "local",
        model: "openai-codex/gpt-5.3-codex",
      }),
    );

    warnSpy.mockRestore();
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

  it("forwards non-webm capture format to Spark STT", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        expect(params).toMatchObject({ format: "wav" });
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "ok" };
      }
      if (method === "spark.voice.tts") {
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64", "wav");

    expect(result?.audioBase64).toBe("tts64");
  });

  it("surfaces STT timeout with stage-specific message", async () => {
    vi.useFakeTimers();

    const request = vi.fn(async (method: string) => {
      if (method === "spark.voice.stt") {
        return await new Promise<Record<string, unknown>>(() => {
          // never resolves
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const pending = processVoiceInputSpark(state, "audio64", "wav");
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await pending;

    expect(result).toBeNull();
    expect(state.error).toBe("Speech recognition timed out. Try a shorter phrase.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("surfaces LLM timeout with stage-specific message", async () => {
    vi.useFakeTimers();

    const request = vi.fn(async (method: string) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return await new Promise<Record<string, unknown>>(() => {
          // never resolves
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const pending = processVoiceInputSpark(state, "audio64", "wav");
    await vi.advanceTimersByTimeAsync(120_001);
    const result = await pending;

    expect(result).toBeNull();
    expect(state.error).toBe("Response generation timed out. Try a shorter request.");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("degrades to text-only when TTS times out", async () => {
    vi.useFakeTimers();

    const request = vi.fn(async (method: string) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "assistant reply" };
      }
      if (method === "spark.voice.tts") {
        return await new Promise<Record<string, unknown>>(() => {
          // never resolves
        });
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const pending = processVoiceInputSpark(state, "audio64", "wav");
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;

    expect(result?.response).toBe("assistant reply");
    expect(result?.audioBase64).toBeUndefined();
    expect(state.error).toBe("TTS timed out. Returning text response only.");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
