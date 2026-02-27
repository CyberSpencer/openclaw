import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext, GatewayResponder } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

import { sparkVoiceHandlers } from "./spark-voice.js";

const BASE_ENV = { ...process.env };

function makeInvocation(
  respond: GatewayResponder,
  params: Record<string, unknown>,
  overrides?: {
    context?: Partial<GatewayRequestContext>;
    client?: GatewayClient | null;
  },
) {
  const context: Partial<GatewayRequestContext> = {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    ...overrides?.context,
  };
  return {
    req: { type: "req", id: "1", method: "spark.voice.test", params },
    params,
    respond,
    client: overrides?.client ?? null,
    context: context as GatewayRequestContext,
    isWebchatConnect: () => false,
  };
}

describe("spark voice gateway handlers", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV };
    process.env.DGX_ENABLED = "1";
    process.env.DGX_HOST = "192.168.1.93";
    process.env.DGX_ACCESS_MODE = "lan";
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({});
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes TTS aliases and enforces timeout floor", async () => {
    process.env.DGX_TTS_TIMEOUT_MS = "5000";

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? (JSON.parse(rawBody) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      expect(body.voice).toBe("Vivian");
      expect(body.speaker).toBe("Vivian");
      expect(body.language).toBe("English");
      expect(body.instruct).toBe("Warm, patient tone");
      expect(body.format).toBe("mp3");
      return {
        ok: true,
        status: 200,
        json: async () => ({ audio_base64: "abc", format: "mp3", sample_rate: 24000 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    let capturedTimeoutMs = 0;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      _fn: TimerHandler,
      ms?: number,
    ) => {
      capturedTimeoutMs = Number(ms ?? 0);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.tts"]?.(
      makeInvocation(respond, {
        text: "Hello there",
        speaker: "Vivian",
        language: "English",
        style_prompt: "Warm, patient tone",
        format: "mp3",
      }),
    );

    timeoutSpy.mockRestore();
    expect(capturedTimeoutMs).toBe(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ audio_base64: "abc", format: "mp3", sample_rate: 24000 }),
    );
  });

  it("applies Spark TTS defaults from config when request omits optional fields", async () => {
    mockLoadConfig.mockReturnValue({
      voice: {
        sparkTts: {
          voice: "Serena",
          language: "Auto",
          instruct: "Speak calmly",
          format: "wav",
        },
      },
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? (JSON.parse(rawBody) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      expect(body.voice).toBe("Serena");
      expect(body.speaker).toBe("Serena");
      expect(body.language).toBe("Auto");
      expect(body.instruct).toBe("Speak calmly");
      expect(body.format).toBe("wav");
      return {
        ok: true,
        status: 200,
        json: async () => ({ audio_base64: "abc", format: "wav", sample_rate: 24000 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.tts"]?.(makeInvocation(respond, { text: "Test" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ audio_base64: "abc", format: "wav" }),
    );
  });

  it("rejects oversized STT payloads with stable 2MB contract details", async () => {
    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.stt"]?.(
      makeInvocation(respond, { audio_base64: "a".repeat(3_000_000) }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Audio payload exceeds max size.",
        details: expect.objectContaining({
          code: "VOICE_STT_PAYLOAD_TOO_LARGE",
          max_bytes: 2_097_152,
          message: "Audio payload exceeds max size.",
        }),
      }),
    );
  });

  it("proxies voices discovery from Spark TTS", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ speakers: ["Ryan", "Vivian"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.voices"]?.(makeInvocation(respond, {}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voices: ["Ryan", "Vivian"] }),
    );
  });

  it("maps DGX 413 payload-too-large to stable invalid-request details", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 413,
      text: async () =>
        JSON.stringify({
          error: {
            code: "VOICE_STT_PAYLOAD_TOO_LARGE",
            max_bytes: 2_097_152,
            received_bytes: 2_301_120,
            message: "Audio payload exceeds max size.",
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.stt"]?.(
      makeInvocation(respond, {
        audio_base64: "AAAA",
        format: "wav",
        sample_rate: 16000,
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Audio payload exceeds max size.",
        details: {
          code: "VOICE_STT_PAYLOAD_TOO_LARGE",
          max_bytes: 2_097_152,
          received_bytes: 2_301_120,
          message: "Audio payload exceeds max size.",
        },
      }),
    );
  });

  it("maps DGX structured 400 STT errors to invalid-request with passthrough details", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            code: "VOICE_STT_AUDIO_TOO_SHORT",
            message: "Audio shorter than minimum duration (100 ms).",
            min_duration_ms: 100,
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.stt"]?.(
      makeInvocation(respond, {
        audio_base64: "AAAA",
        format: "wav",
        sample_rate: 16000,
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Audio shorter than minimum duration (100 ms).",
        details: {
          code: "VOICE_STT_AUDIO_TOO_SHORT",
          message: "Audio shorter than minimum duration (100 ms).",
          min_duration_ms: 100,
        },
      }),
    );
  });

  it("routes STT to WAN endpoint, forwards request id, and returns merged timing fields", async () => {
    process.env.DGX_ACCESS_MODE = "wan";
    process.env.DGX_WAN_BASE_URL = "https://abc123.ngrok-free.dev";
    process.env.DGX_WAN_TOKEN = "wan-token";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://abc123.ngrok-free.dev/voice-stt/v1/transcribe");
      expect(init?.method).toBe("POST");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["ngrok-skip-browser-warning"]).toBe("true");
      expect(headers["X-OpenClaw-Token"]).toBe("wan-token");
      expect(typeof headers["x-request-id"]).toBe("string");
      expect(headers["x-request-id"]?.length).toBeGreaterThan(0);
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "x-request-id" ? headers["x-request-id"] : null,
        },
        json: async () => ({
          text: "hello from wan",
          request_id: headers["x-request-id"],
          timings_ms: { total_ms: 408.4 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.stt"]?.(
      makeInvocation(respond, {
        audio_base64: "AAAA",
        format: "wav",
        sample_rate: 16000,
        language: "en",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        text: "hello from wan",
        request_id: expect.any(String),
        timings_ms: expect.objectContaining({
          gateway_receive_ms: expect.any(Number),
          gateway_proxy_outbound_ms: expect.any(Number),
          gateway_wait_dgx_ms: expect.any(Number),
          gateway_serialize_send_ms: expect.any(Number),
          gateway_total_ms: expect.any(Number),
          dgx_total_ms: 408,
        }),
      }),
    );
  });

  it("forwards Spark STT correlation ids via headers and echoes turn_id", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-request-id"]).toBe("voice-turn-77-stt");
      expect(headers["x-turn-id"]).toBe("voice-turn-77");
      expect(headers["x-conversation-id"]).toBe("voice-conv-77");
      expect(headers["x-session-key"]).toBe("agent:main:main");
      expect(headers["x-client-message-id"]).toBe("voice-msg-77");
      expect(headers["x-source"]).toBe("voice");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          text: "hello",
          request_id: "voice-turn-77-stt",
          timings_ms: { total_ms: 120.2 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.stt"]?.(
      makeInvocation(respond, {
        audio_base64: "AAAA",
        format: "wav",
        sample_rate: 16000,
        requestId: "voice-turn-77-stt",
        turnId: "voice-turn-77",
        conversationId: "voice-conv-77",
        sessionKey: "agent:main:main",
        clientMessageId: "voice-msg-77",
        source: "voice",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        text: "hello",
        request_id: "voice-turn-77-stt",
        turn_id: "voice-turn-77",
      }),
    );
  });

  it("forwards Spark TTS correlation ids via headers and body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-request-id"]).toBe("voice-turn-88-tts");
      expect(headers["x-turn-id"]).toBe("voice-turn-88");
      expect(headers["x-conversation-id"]).toBe("voice-conv-88");
      expect(headers["x-session-key"]).toBe("agent:main:main");
      expect(headers["x-client-message-id"]).toBe("voice-msg-88");
      expect(headers["x-source"]).toBe("voice");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      expect(body.turn_id).toBe("voice-turn-88");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          audio_base64: "abc",
          format: "webm",
          sample_rate: 24000,
          turn_id: "voice-turn-88",
          timings_ms: { compute_ms: 615.4, total_ms: 615.4 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.tts"]?.(
      makeInvocation(respond, {
        text: "hello",
        format: "webm",
        requestId: "voice-turn-88-tts",
        turnId: "voice-turn-88",
        conversationId: "voice-conv-88",
        sessionKey: "agent:main:main",
        clientMessageId: "voice-msg-88",
        source: "voice",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audio_base64: "abc",
        turn_id: "voice-turn-88",
        timings_ms: expect.objectContaining({ compute_ms: 615.4, total_ms: 615.4 }),
      }),
    );
  });

  it("streams Spark TTS over gateway events and acks immediately", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-stream-id"]).toBe("stream-1");
      return {
        ok: true,
        status: 200,
        json: async () => ({ audio_base64: "abc123", format: "webm", sample_rate: 24000 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    await sparkVoiceHandlers["spark.voice.tts.stream"]?.(
      makeInvocation(
        respond,
        {
          text: "Stream this",
          streamId: "stream-1",
          sessionKey: "agent:main:main",
          conversationId: "voice-conv-1",
          turnId: "voice-turn-1",
        },
        {
          context: {
            broadcastToConnIds,
            nodeSendToSession,
          },
          client: {
            connId: "conn-1",
            connect: {
              role: "operator",
              scopes: ["operator.write", "operator.read"],
              client: { id: "test-client" },
            },
          } as GatewayClient,
        },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ streamId: "stream-1", accepted: true }),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(broadcastToConnIds).toHaveBeenCalled();
    });

    const streamEvents = broadcastToConnIds.mock.calls.map((call) => call[0]);
    expect(streamEvents).toContain("spark.voice.stream.started");
    expect(streamEvents).toContain("spark.voice.stream.chunk");
    expect(streamEvents).toContain("spark.voice.stream.completed");
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "agent:main:main",
      "spark.voice.stream.chunk",
      expect.objectContaining({ streamId: "stream-1", seq: 1, audioBase64: "abc123" }),
    );
  });

  it("parses ndjson stream chunks and done metadata without explicit event names", async () => {
    const ndjson = [
      JSON.stringify({
        seq: 1,
        audio_base64: "chunk-1",
        format: "webm",
        sample_rate: 24000,
        chunkDurationMs: 180,
        isLast: false,
      }),
      JSON.stringify({
        seq: 2,
        audio_base64: "chunk-2",
        format: "webm",
        sample_rate: 24000,
        chunkDurationMs: 190,
        isLast: true,
      }),
      JSON.stringify({ totalChunks: 2, durationMs: 321, done: true, format: "webm" }),
      "",
    ].join("\n");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-stream-id"]).toBe("stream-ndjson");
      return new Response(ndjson, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    await sparkVoiceHandlers["spark.voice.tts.stream"]?.(
      makeInvocation(
        respond,
        {
          text: "Stream NDJSON",
          streamId: "stream-ndjson",
          sessionKey: "agent:main:main",
        },
        {
          context: {
            broadcastToConnIds,
            nodeSendToSession,
          },
          client: {
            connId: "conn-ndjson",
            connect: {
              role: "operator",
              scopes: ["operator.write", "operator.read"],
              client: { id: "test-client" },
            },
          } as GatewayClient,
        },
      ),
    );

    const chunkCalls = nodeSendToSession.mock.calls
      .filter((call) => call[1] === "spark.voice.stream.chunk")
      .map((call) => call[2] as Record<string, unknown>);
    expect(chunkCalls).toHaveLength(2);
    expect(chunkCalls[0]).toMatchObject({
      streamId: "stream-ndjson",
      seq: 1,
      audioBase64: "chunk-1",
      chunkDurationMs: 180,
      isLast: false,
    });
    expect(chunkCalls[1]).toMatchObject({
      streamId: "stream-ndjson",
      seq: 2,
      audioBase64: "chunk-2",
      chunkDurationMs: 190,
      isLast: true,
    });
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "agent:main:main",
      "spark.voice.stream.completed",
      expect.objectContaining({
        streamId: "stream-ndjson",
        totalChunks: 2,
        durationMs: 321,
      }),
    );
  });

  it("treats ndjson nested error payload as terminal stream error without fallback", async () => {
    const ndjson = `${JSON.stringify({
      error: { code: "VOICE_TTS_CANCELLED", message: "Stream cancelled" },
    })}\n`;
    const fetchMock = vi.fn(
      async () =>
        new Response(ndjson, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    const nodeSendToSession = vi.fn();
    await sparkVoiceHandlers["spark.voice.tts.stream"]?.(
      makeInvocation(
        respond,
        {
          text: "Cancel me",
          streamId: "stream-cancelled",
          sessionKey: "agent:main:main",
          turnId: "voice-turn-cancelled",
        },
        {
          context: {
            broadcastToConnIds: vi.fn(),
            nodeSendToSession,
          },
          client: {
            connId: "conn-cancelled",
            connect: {
              role: "operator",
              scopes: ["operator.write", "operator.read"],
              client: { id: "test-client" },
            },
          } as GatewayClient,
        },
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "agent:main:main",
      "spark.voice.stream.error",
      expect.objectContaining({
        streamId: "stream-cancelled",
        turnId: "voice-turn-cancelled",
        code: "VOICE_TTS_CANCELLED",
        message: "Stream cancelled",
      }),
    );
    expect(
      nodeSendToSession.mock.calls.some((call) => call[1] === "spark.voice.stream.completed"),
    ).toBe(false);
  });

  it("normalizes multi-chunk Spark TTS payloads into deterministic sequence events", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        chunks: [
          { audio_base64: "chunk-a", format: "webm", sample_rate: 24000 },
          { audioBase64: "chunk-b", format: "webm", sampleRate: 24000 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    await sparkVoiceHandlers["spark.voice.tts.stream"]?.(
      makeInvocation(
        respond,
        {
          text: "Stream chunks",
          streamId: "stream-2",
          sessionKey: "agent:main:main",
        },
        {
          context: {
            broadcastToConnIds,
            nodeSendToSession,
          },
          client: {
            connId: "conn-2",
            connect: {
              role: "operator",
              scopes: ["operator.write", "operator.read"],
              client: { id: "test-client" },
            },
          } as GatewayClient,
        },
      ),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(nodeSendToSession).toHaveBeenCalledWith(
        "agent:main:main",
        "spark.voice.stream.completed",
        expect.objectContaining({ streamId: "stream-2", totalChunks: 2 }),
      );
    });

    const chunkCalls = nodeSendToSession.mock.calls
      .filter((call) => call[1] === "spark.voice.stream.chunk")
      .map((call) => call[2] as Record<string, unknown>);
    expect(chunkCalls).toHaveLength(2);
    expect(chunkCalls[0]).toMatchObject({ streamId: "stream-2", seq: 1, audioBase64: "chunk-a" });
    expect(chunkCalls[1]).toMatchObject({ streamId: "stream-2", seq: 2, audioBase64: "chunk-b" });
  });

  it("strips stream_id from non-stream fallback payload after stream endpoint fallback", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/synthesize/stream")) {
        return {
          ok: false,
          status: 404,
          text: async () => "not found",
        };
      }
      expect(url).toBe("http://192.168.1.93:9002/v1/synthesize");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      expect(body.stream_id).toBeUndefined();
      expect(body.turn_id).toBe("voice-turn-fallback");
      return {
        ok: true,
        status: 200,
        json: async () => ({ audio_base64: "fallback-audio", format: "webm", sample_rate: 24000 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    const nodeSendToSession = vi.fn();
    await sparkVoiceHandlers["spark.voice.tts.stream"]?.(
      makeInvocation(
        respond,
        {
          text: "Fallback body check",
          streamId: "stream-fallback",
          sessionKey: "agent:main:main",
          turnId: "voice-turn-fallback",
        },
        {
          context: {
            broadcastToConnIds: vi.fn(),
            nodeSendToSession,
          },
          client: {
            connId: "conn-fallback",
            connect: {
              role: "operator",
              scopes: ["operator.write", "operator.read"],
              client: { id: "test-client" },
            },
          } as GatewayClient,
        },
      ),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(nodeSendToSession).toHaveBeenCalledWith(
        "agent:main:main",
        "spark.voice.stream.completed",
        expect.objectContaining({ streamId: "stream-fallback", totalChunks: 1 }),
      );
    });
  });

  it("forwards spark.voice.tts.cancel to DGX cancel endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://192.168.1.93:9002/v1/cancel");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-stream-id"]).toBe("stream-cancel-1");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      expect(body.turn_id).toBe("voice-turn-cancel");
      expect(body.stream_id).toBe("stream-cancel-1");
      return {
        ok: true,
        status: 200,
        json: async () => ({ cancelled: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const respond = vi.fn<GatewayResponder>();
    await sparkVoiceHandlers["spark.voice.tts.cancel"]?.(
      makeInvocation(respond, {
        streamId: "stream-cancel-1",
        turnId: "voice-turn-cancel",
        sessionKey: "agent:main:main",
        conversationId: "voice-conv-1",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        cancelled: true,
        cancelledStreamIds: [],
        remoteCancelAttempted: true,
        remoteCancelOk: true,
      }),
    );
  });
});
