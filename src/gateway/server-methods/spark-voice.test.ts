import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, GatewayResponder } from "./types.js";

const mockLoadConfig = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

import { sparkVoiceHandlers } from "./spark-voice.js";

const BASE_ENV = { ...process.env };

function makeInvocation(respond: GatewayResponder, params: Record<string, unknown>) {
  return {
    req: { type: "req", id: "1", method: "spark.voice.test", params },
    params,
    respond,
    client: null,
    context: {} as GatewayRequestContext,
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
});
