import { describe, expect, it } from "vitest";
import type { ConnectParams } from "../../protocol/index.js";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
import {
  extractFrameMeta,
  validateBrowserOrigin,
  validateConnectHandshakeFrame,
  validateProtocolCompatibility,
  validateRoleAndScopes,
} from "./handshake-phase1.js";

function buildConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 99,
    client: {
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      version: "1.0.0",
      platform: "darwin",
      mode: "webchat",
      ...overrides?.client,
    },
    ...overrides,
  } as ConnectParams;
}

describe("handshake-phase1", () => {
  it("extracts frame metadata when present", () => {
    expect(
      extractFrameMeta({
        type: "req",
        method: "connect",
        id: "abc",
      }),
    ).toEqual({ type: "req", method: "connect", id: "abc" });
  });

  it("rejects non-request handshake payloads", () => {
    const result = validateConnectHandshakeFrame({ type: "evt", event: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toBe("invalid request frame");
      expect(result.isRequestFrame).toBe(false);
    }
  });

  it("rejects first request when method is not connect", () => {
    const result = validateConnectHandshakeFrame({ type: "req", id: "1", method: "status" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("first request must be connect");
      expect(result.requestId).toBe("1");
    }
  });

  it("rejects invalid connect params", () => {
    const result = validateConnectHandshakeFrame({
      type: "req",
      id: "2",
      method: "connect",
      params: { minProtocol: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("invalid connect params");
      expect(result.requestId).toBe("2");
    }
  });

  it("accepts valid connect frame", () => {
    const params = buildConnectParams();
    const result = validateConnectHandshakeFrame({
      type: "req",
      id: "3",
      method: "connect",
      params,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.id).toBe("3");
      expect(result.connectParams.client.id).toBe(GATEWAY_CLIENT_IDS.CONTROL_UI);
    }
  });

  it("detects protocol mismatch", () => {
    const result = validateProtocolCompatibility(buildConnectParams({ minProtocol: 999 }), 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toBe("protocol mismatch");
      expect(result.expectedProtocol).toBe(3);
    }
  });

  it("normalizes role and default scopes", () => {
    const result = validateRoleAndScopes(buildConnectParams({ role: "operator", scopes: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe("operator");
      expect(result.scopes).toEqual(["operator.admin"]);
    }
  });

  it("rejects invalid role", () => {
    const result = validateRoleAndScopes(buildConnectParams({ role: "invalid-role" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toBe("invalid role");
    }
  });

  it("skips origin checks for non-browser clients", () => {
    const result = validateBrowserOrigin({
      requestHost: "127.0.0.1:8080",
      requestOrigin: "https://evil.example",
      isControlUi: false,
      isWebchat: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects browser origin mismatch", () => {
    const result = validateBrowserOrigin({
      requestHost: "127.0.0.1:8080",
      requestOrigin: "https://evil.example",
      isControlUi: true,
      isWebchat: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("origin not allowed");
    }
  });
});
