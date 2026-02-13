import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";

const BASE_ENV = { ...process.env };

describe("gateway spark.voice method registration and auth", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV };
    process.env.DGX_ENABLED = "1";
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
        json: async () => ({ speakers: ["Ryan", "Vivian"] }),
      })),
    );

    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "1", method: "spark.voice.voices", params: {} },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
      } as never,
      isWebchatConnect: false,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ voices: ["Ryan", "Vivian"] }),
    );
  });

  it("requires operator.write scope for spark.voice.stt", async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "spark.voice.stt",
        params: { audio_base64: "AAAA", format: "wav", sample_rate: 16000, language: "en" },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
      } as never,
      isWebchatConnect: false,
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

  it("dispatches spark.voice.stt for operator.write scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ text: "ok", language_detected: "English" }),
      })),
    );

    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "spark.voice.stt",
        params: { audio_base64: "AAAA", format: "wav", sample_rate: 16000, language: "en" },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.write"] },
      } as never,
      isWebchatConnect: false,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ text: "ok", language_detected: "English" }),
    );
  });
});
