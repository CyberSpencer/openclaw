import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import { sparkVoiceMethodsHandlers } from "./server-methods/spark-voice-methods.js";

const BASE_ENV = { ...process.env };

describe("gateway spark.voice method registration and auth", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV };
    process.env.DGX_HOST = "192.168.1.93";
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dispatches spark.voice.voices for operator.read scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ voices: ["Ryan", "Vivian"] }),
      })),
    );

    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "1", method: "spark.voice.voices", params: {} },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
      } as never,
      isWebchatConnect: false as never,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voices: ["Ryan", "Vivian"] }),
      undefined,
    );
  });

  it("requires operator.write scope for spark.voice.tts.stream", async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "spark.voice.tts.stream",
        params: { text: "hello" },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
        connId: "conn-read",
      } as never,
      isWebchatConnect: false as never,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.write",
      }),
    );
  });
});

describe("spark.voice.tts.stream", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV };
    process.env.DGX_HOST = "192.168.1.93";
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("acknowledges the request and emits stream events to the requester", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"audio_base64":"chunk-1","format":"webm"}\n\n'),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"audio_base64":"chunk-2","format":"webm"}\n\ndata: {"done":true}\n\n',
              ),
            );
            controller.close();
          },
        }),
      })),
    );

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();

    await sparkVoiceMethodsHandlers["spark.voice.tts.stream"]({
      params: {
        text: "hello world",
        streamId: "stream-1",
        sessionKey: "agent:main:chat:voice",
        conversationId: "conv-1",
        turnId: "turn-1",
        clientMessageId: "msg-1",
        source: "voice",
      },
      respond,
      context: { broadcastToConnIds } as never,
      client: {
        connId: "conn-1",
        connect: { role: "operator", scopes: ["operator.write"] },
      } as never,
      isWebchatConnect: false as never,
      req: { type: "req", id: "1", method: "spark.voice.tts.stream", params: {} } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ accepted: true, streamId: "stream-1" }),
      undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(broadcastToConnIds.mock.calls.map((call) => call[0])).toEqual([
      "spark.voice.stream.started",
      "spark.voice.stream.chunk",
      "spark.voice.stream.chunk",
      "spark.voice.stream.completed",
    ]);
    expect(broadcastToConnIds.mock.calls[0]?.[2]).toEqual(new Set(["conn-1"]));
    expect(broadcastToConnIds.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        streamId: "stream-1",
        seq: 1,
        audioBase64: "chunk-1",
        format: "webm",
      }),
    );
    expect(broadcastToConnIds.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        streamId: "stream-1",
        totalChunks: 2,
      }),
    );
  });
});
