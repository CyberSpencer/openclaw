import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceState, handleSparkVoiceStreamEvent, processVoiceInputSpark } from "./voice.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("processVoiceInputSpark", () => {
  it("runs STT -> voice.processText(skipTts) -> Spark TTS sequence", async () => {
    const expectedConversationId = "voice-conv-123";
    const expectedTurnId = "voice-turn-123";
    const expectedClientMessageId = "voice-msg-123";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        expect(params).toMatchObject({
          audio_base64: "audio64",
          format: "webm",
          requestId: "voice-turn-123-stt",
          conversationId: expectedConversationId,
          turnId: expectedTurnId,
          clientMessageId: expectedClientMessageId,
          source: "voice",
        });
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        expect(params).toMatchObject({
          text: "hello world",
          requestId: "voice-turn-123-llm",
          sessionKey: "agent:main:main",
          driveOpenClaw: true,
          skipTts: true,
          conversationId: expectedConversationId,
          turnId: expectedTurnId,
          clientMessageId: expectedClientMessageId,
          source: "voice",
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
        expect(params).toMatchObject({
          text: "assistant reply",
          format: "webm",
          requestId: "voice-turn-123-tts",
          sessionKey: "agent:main:main",
          conversationId: expectedConversationId,
          turnId: expectedTurnId,
          clientMessageId: expectedClientMessageId,
          source: "voice",
        });
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.sparkTtsStreamSupport = "unsupported";
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;
    state.sessionKey = "agent:main:main";
    state.driveOpenClaw = true;

    const result = await processVoiceInputSpark(state, "audio64", "webm", undefined, {
      conversationId: expectedConversationId,
      turnId: expectedTurnId,
      clientMessageId: expectedClientMessageId,
      source: "voice",
    });

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

  it("uses provisional low-latency voice.processText request when spokenOutputMode is provided", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        if (params?.provisional === true) {
          return {
            sessionId: "voice-session-provisional",
            response: "quick preview",
            spokenResponse: "quick preview",
            provisional: true,
            timings: { llmFirstSemanticMs: 120, llmFullCompletionMs: 220, llmMs: 220 },
          };
        }
        return await new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(
            () =>
              resolve({
                sessionId: "voice-session-canonical",
                response: "canonical answer",
                timings: { llmFirstSemanticMs: 2000, llmFullCompletionMs: 6000, llmMs: 6000 },
              }),
            30,
          );
        });
      }
      if (method === "spark.voice.tts") {
        expect(params?.text).toBe("quick preview");
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.sparkTtsStreamSupport = "unsupported";
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;
    state.sessionKey = "agent:main:main";

    const result = await processVoiceInputSpark(state, "audio64", "webm", undefined, {
      conversationId: "voice-conv-provisional",
      turnId: "voice-turn-provisional",
      clientMessageId: "voice-msg-provisional",
      source: "voice",
      spokenOutputMode: "concise",
    });

    const llmCalls = request.mock.calls.filter((call) => call[0] === "voice.processText");
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls.some((call) => call[1]?.provisional === false)).toBe(true);
    expect(
      llmCalls.some(
        (call) =>
          call[1]?.provisional === true &&
          call[1]?.latencyProfile === "short_turn_fast" &&
          call[1]?.allowTools === false,
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      response: "quick preview",
      provisional: true,
      audioBase64: "tts64",
    });
  });

  it("forces provisional status mode on action-like turns and keeps canonical tools enabled", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        return { text: "send an email to the team with this update" };
      }
      if (method === "voice.processText") {
        if (params?.provisional === true) {
          expect(params?.spokenOutputMode).toBe("status");
          expect(params?.allowTools).toBe(false);
          return {
            sessionId: "voice-session-provisional",
            response: "I can draft and send that for you.",
            spokenResponse: "I can draft and send that for you.",
            provisional: true,
            timings: { llmFirstSemanticMs: 150, llmFullCompletionMs: 280, llmMs: 280 },
          };
        }
        expect(params?.provisional).toBe(false);
        expect(params?.spokenOutputMode).toBe("concise");
        expect(params?.allowTools).toBe(true);
        return await new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(
            () =>
              resolve({
                sessionId: "voice-session-canonical",
                response: "Done, I sent it to the team.",
                toolActivity: true,
                timings: { llmFirstSemanticMs: 1100, llmFullCompletionMs: 3200, llmMs: 3200 },
              }),
            20,
          );
        });
      }
      if (method === "spark.voice.tts") {
        expect(params?.text).toBe("I can draft and send that for you.");
        return { audio_base64: "tts64", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const state = createVoiceState();
    state.sparkTtsStreamSupport = "unsupported";
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;
    state.sessionKey = "agent:main:main";

    const result = await processVoiceInputSpark(state, "audio64", "webm", undefined, {
      conversationId: "voice-conv-action",
      turnId: "voice-turn-action",
      clientMessageId: "voice-msg-action",
      source: "voice",
      spokenOutputMode: "concise",
    });

    const llmCalls = request.mock.calls.filter((call) => call[0] === "voice.processText");
    expect(llmCalls).toHaveLength(2);
    expect(
      llmCalls.some(
        (call) => call[1]?.provisional === true && call[1]?.spokenOutputMode === "status",
      ),
    ).toBe(true);
    expect(
      llmCalls.some((call) => call[1]?.provisional === false && call[1]?.allowTools === true),
    ).toBe(true);
    expect(result).toMatchObject({
      response: "I can draft and send that for you.",
      provisional: true,
      audioBase64: "tts64",
    });
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
    state.sparkTtsStreamSupport = "unsupported";
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
    state.sparkTtsStreamSupport = "unsupported";
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
    state.sparkTtsStreamSupport = "unsupported";
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
    state.sparkTtsStreamSupport = "unsupported";
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
    state.sparkTtsStreamSupport = "unsupported";
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
    state.sparkTtsStreamSupport = "unsupported";
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

  it("returns without error when turn signal is already aborted", async () => {
    const request = vi.fn();
    const state = createVoiceState();
    state.sparkTtsStreamSupport = "unsupported";
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const controller = new AbortController();
    controller.abort();

    const result = await processVoiceInputSpark(state, "audio64", "wav", controller.signal);

    expect(result).toBeNull();
    expect(state.error).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses spark.voice.tts.stream when stream events are available", async () => {
    const state = createVoiceState();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "assistant reply" };
      }
      if (method === "spark.voice.tts.stream") {
        const streamId = typeof params?.streamId === "string" ? params.streamId : "stream-1";
        expect(params).toMatchObject({
          conversationId: "voice-conv-stream",
          turnId: "voice-turn-stream",
          clientMessageId: "voice-msg-stream",
          source: "voice",
          requestId: "voice-turn-stream-tts",
        });
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.chunk", {
          streamId,
          seq: 1,
          audioBase64: "streamed-audio",
          format: "webm",
        });
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.completed", {
          streamId,
          totalChunks: 1,
        });
        return { streamId, accepted: true };
      }
      if (method === "spark.voice.tts") {
        throw new Error("spark.voice.tts fallback should not be used when stream succeeds");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64", "webm", undefined, {
      conversationId: "voice-conv-stream",
      turnId: "voice-turn-stream",
      clientMessageId: "voice-msg-stream",
      source: "voice",
    });

    expect(result?.audioBase64).toBe("streamed-audio");
    expect(result?.audioChunks).toEqual([{ audioBase64: "streamed-audio", audioFormat: "webm" }]);
    expect(state.sparkTtsStreamSupport).toBe("supported");
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stt",
      "voice.processText",
      "spark.voice.tts.stream",
    ]);
  });

  it("falls back to spark.voice.tts when stream completes with missing chunks", async () => {
    const state = createVoiceState();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "assistant reply" };
      }
      if (method === "spark.voice.tts.stream") {
        const streamId = typeof params?.streamId === "string" ? params.streamId : "stream-1";
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.chunk", {
          streamId,
          seq: 2,
          audioBase64: "missing-first-chunk",
          format: "webm",
        });
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.completed", {
          streamId,
          totalChunks: 2,
        });
        return { streamId, accepted: true };
      }
      if (method === "spark.voice.tts.cancel") {
        return {
          cancelled: true,
          cancelledStreamIds: [],
          remoteCancelAttempted: false,
          remoteCancelOk: null,
        };
      }
      if (method === "spark.voice.tts") {
        return { audio_base64: "fallback-audio", format: "webm" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64", "webm");

    expect(result?.audioBase64).toBe("fallback-audio");
    expect(result?.audioChunks).toEqual([{ audioBase64: "fallback-audio", audioFormat: "webm" }]);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stt",
      "voice.processText",
      "spark.voice.tts.stream",
      "spark.voice.tts.cancel",
      "spark.voice.tts",
    ]);
  });

  it("accepts out-of-order stream chunks when sequence is contiguous by completion", async () => {
    const state = createVoiceState();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "spark.voice.stt") {
        return { text: "hello world" };
      }
      if (method === "voice.processText") {
        return { sessionId: "voice-session", response: "assistant reply" };
      }
      if (method === "spark.voice.tts.stream") {
        const streamId = typeof params?.streamId === "string" ? params.streamId : "stream-1";
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.chunk", {
          streamId,
          seq: 2,
          audioBase64: "chunk-two",
          format: "webm",
        });
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.chunk", {
          streamId,
          seq: 1,
          audioBase64: "chunk-one",
          format: "webm",
        });
        handleSparkVoiceStreamEvent(state, "spark.voice.stream.completed", {
          streamId,
          totalChunks: 2,
        });
        return { streamId, accepted: true };
      }
      if (method === "spark.voice.tts") {
        throw new Error("spark.voice.tts fallback should not run when chunks reconcile");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const result = await processVoiceInputSpark(state, "audio64", "webm", undefined, {
      conversationId: "voice-conv-jitter",
      turnId: "voice-turn-jitter",
      clientMessageId: "voice-msg-jitter",
      source: "voice",
    });

    expect(result?.audioChunks).toEqual([
      { audioBase64: "chunk-one", audioFormat: "webm" },
      { audioBase64: "chunk-two", audioFormat: "webm" },
    ]);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stt",
      "voice.processText",
      "spark.voice.tts.stream",
    ]);
  });

  it("cancels an in-flight STT call when turn signal aborts", async () => {
    const request = vi.fn(
      async (_method: string, _params: Record<string, unknown>, opts?: { signal?: AbortSignal }) =>
        await new Promise<Record<string, unknown>>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
        }),
    );
    const state = createVoiceState();
    state.sparkTtsStreamSupport = "unsupported";
    state.connected = true;
    state.client = { request } as unknown as typeof state.client;

    const controller = new AbortController();
    const pending = processVoiceInputSpark(state, "audio64", "wav", controller.signal);
    controller.abort();
    const result = await pending;

    expect(result).toBeNull();
    expect(state.error).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
