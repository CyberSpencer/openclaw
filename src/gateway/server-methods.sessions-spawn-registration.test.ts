import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";

describe("gateway sessions.spawn method registration and auth", () => {
  it("requires operator.write scope for sessions.spawn", async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "sessions.spawn",
        params: { requesterSessionKey: "main", task: "test task" },
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

  it("dispatches sessions.spawn handler for operator.write scope", async () => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "sessions.spawn",
        params: {},
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.write"] },
      } as never,
      isWebchatConnect: false,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("invalid sessions.spawn params"),
      }),
    );
  });
});
