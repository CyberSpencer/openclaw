import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import {
  getDeliveryByIdempotencyKey,
  markDeliveryFailed,
  registerDelivery,
  resetDeliveryLedgerForTests,
} from "../../infra/outbound/delivery-ledger.js";
import { sendHandlers } from "./send.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => ({ outbound: {} }),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: () => ({ ok: true, to: "resolved" }),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
  }) as unknown as GatewayRequestContext;

afterEach(() => {
  resetDeliveryLedgerForTests();
  vi.clearAllMocks();
});

describe("gateway send mirroring", () => {
  it("does not mirror when delivery returns no results", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([]);

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-1",
        sessionKey: "agent:main:main",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
        }),
      }),
    );
  });

  it("mirrors media filenames when delivery succeeds", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId: "m1", channel: "slack" }]);

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "caption",
        mediaUrl: "https://example.com/files/report.pdf?sig=1",
        channel: "slack",
        idempotencyKey: "idem-2",
        sessionKey: "agent:main:main",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "caption",
          mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
        }),
      }),
    );
  });

  it("mirrors MEDIA tags as attachments", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId: "m2", channel: "slack" }]);

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "Here\nMEDIA:https://example.com/image.png",
        channel: "slack",
        idempotencyKey: "idem-3",
        sessionKey: "agent:main:main",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:main",
          text: "Here",
          mediaUrls: ["https://example.com/image.png"],
        }),
      }),
    );
  });

  it("lowercases provided session keys for mirroring", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId: "m-lower", channel: "slack" }]);

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "hi",
        channel: "slack",
        idempotencyKey: "idem-lower",
        sessionKey: "agent:main:slack:channel:C123",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:c123",
        }),
      }),
    );
  });

  it("derives a target session key when none is provided", async () => {
    mocks.deliverOutboundPayloads.mockResolvedValue([{ messageId: "m3", channel: "slack" }]);

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "hello",
        channel: "slack",
        idempotencyKey: "idem-4",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.recordSessionMetaFromInbound).toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          sessionKey: "agent:main:slack:channel:resolved",
          agentId: "main",
        }),
      }),
    );
  });

  it("exposes delivery ledger entries over gateway methods", async () => {
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("temporary timeout"))
      .mockResolvedValueOnce([{ messageId: "m-ledger", channel: "slack" }]);

    const context = makeContext();
    const sendRespond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "hello",
        channel: "slack",
        idempotencyKey: "idem-ledger",
        urgency: "high",
      },
      respond: sendRespond,
      context,
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    const listRespond = vi.fn();
    await sendHandlers["send.ledger.list"]({
      params: { idempotencyKey: "idem-ledger", limit: 5 },
      respond: listRespond,
      context,
      req: { type: "req", id: "2", method: "send.ledger.list" },
      client: null,
      isWebchatConnect: () => false,
    });

    const listPayload = listRespond.mock.calls[0]?.[1] as {
      entries?: Array<{ id: string; state: string; events: Array<{ state: string }> }>;
    };
    const entry = listPayload?.entries?.[0];
    expect(entry?.state).toBe("sent");
    expect(entry?.events.map((event) => event.state)).toContain("retrying");

    const getRespond = vi.fn();
    await sendHandlers["send.ledger.get"]({
      params: { id: entry?.id },
      respond: getRespond,
      context,
      req: { type: "req", id: "3", method: "send.ledger.get" },
      client: null,
      isWebchatConnect: () => false,
    });

    const getPayload = getRespond.mock.calls[0]?.[1] as {
      entry?: { id: string; idempotencyKey?: string };
    };
    expect(getPayload.entry?.id).toBe(entry?.id);
    expect(getPayload.entry?.idempotencyKey).toBe("idem-ledger");
  });

  it("does not acknowledge failed deliveries on dedupe cache hits", async () => {
    const ledger = registerDelivery({
      idempotencyKey: "idem-failed-cache",
      action: "send",
      channel: "slack",
      to: "resolved",
      payloadType: "text",
      urgency: "normal",
    });
    markDeliveryFailed({ id: ledger.id, error: "simulated failure" });

    const context = makeContext();
    context.dedupe.set("send:idem-failed-cache", {
      ts: Date.now(),
      ok: false,
      error: { code: -32000, message: "cached failure" },
    });

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C1",
        message: "retry me",
        channel: "slack",
        idempotencyKey: "idem-failed-cache",
      },
      respond,
      context,
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    const entry = getDeliveryByIdempotencyKey("idem-failed-cache");
    expect(entry?.state).toBe("failed");
    expect(entry?.events.at(-1)?.state).toBe("failed");
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object), { cached: true });
  });
});
