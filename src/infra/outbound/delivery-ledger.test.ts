import { afterEach, describe, expect, it } from "vitest";
import {
  getDeliveryById,
  getDeliveryByIdempotencyKey,
  listDeliveries,
  markDeliveryAcknowledged,
  markDeliveryFailed,
  markDeliveryRetrying,
  markDeliverySent,
  registerDelivery,
  resetDeliveryLedgerForTests,
} from "./delivery-ledger.js";

afterEach(() => {
  resetDeliveryLedgerForTests();
});

describe("delivery ledger", () => {
  it("records queued -> retrying -> sent transitions", () => {
    const queued = registerDelivery({
      idempotencyKey: "idem-1",
      action: "send",
      channel: "slack",
      to: "channel:C1",
      payloadType: "text",
      urgency: "normal",
      explicitChannel: false,
      routeReason: "priority-default",
    });

    const retrying = markDeliveryRetrying({ id: queued.id, error: "timeout", delayMs: 250 });
    const sent = markDeliverySent({
      id: queued.id,
      result: { gatewayPayload: { messageId: "m1" } },
    });

    expect(retrying.state).toBe("retrying");
    expect(retrying.attempts).toBe(1);
    expect(sent.state).toBe("sent");
    expect(sent.result?.gatewayPayload?.messageId).toBe("m1");

    const fetched = getDeliveryById(queued.id);
    expect(fetched?.events.map((event) => event.state)).toEqual(["queued", "retrying", "sent"]);
  });

  it("supports failed and acknowledged transitions", () => {
    const queued = registerDelivery({
      idempotencyKey: "idem-2",
      action: "send",
      channel: "telegram",
      to: "@ops",
      payloadType: "media",
      urgency: "high",
      explicitChannel: true,
      routeReason: "explicit-channel",
    });

    const failed = markDeliveryFailed({ id: queued.id, error: "network down" });
    const ack = markDeliveryAcknowledged({ id: queued.id, note: "operator reviewed" });

    expect(failed.state).toBe("failed");
    expect(ack.state).toBe("acknowledged");
    expect(ack.lastError).toContain("network down");
  });

  it("reuses idempotency entries and supports lookup/list filters", () => {
    const first = registerDelivery({
      idempotencyKey: "idem-same",
      action: "send",
      channel: "matrix",
      to: "@alice:matrix.org",
      payloadType: "text",
      urgency: "critical",
    });
    const second = registerDelivery({
      idempotencyKey: "idem-same",
      action: "send",
      channel: "slack",
      to: "channel:C9",
      payloadType: "text",
      urgency: "low",
    });

    expect(second.id).toBe(first.id);
    expect(getDeliveryByIdempotencyKey("idem-same")?.id).toBe(first.id);

    const listed = listDeliveries({ limit: 10, channel: "matrix" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(first.id);
  });
});
