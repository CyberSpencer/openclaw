import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayHost } from "./app-gateway.ts";
import { connectGateway } from "./app-gateway.ts";

type GatewayClientOptions = {
  onClose?: (info: { code: number; reason: string }) => void;
};

const mockGatewayInstances: Array<{ opts: GatewayClientOptions }> = [];

vi.mock("./gateway.ts", () => ({
  GatewayBrowserClient: class {
    opts: GatewayClientOptions;
    constructor(opts: GatewayClientOptions) {
      this.opts = opts;
      mockGatewayInstances.push({ opts });
    }
    start() {}
    stop() {}
  },
}));

function createHost(): GatewayHost {
  return {
    settings: {
      gatewayUrl: "ws://gateway.local",
      token: "",
    },
    password: "",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    onboarding: false,
    eventLogBuffer: [],
    eventLog: [],
    execApprovalQueue: [],
    execApprovalError: null,
    sessionKey: "main",
    resetAllSessionRunState: vi.fn(),
    getSessionRunHost: vi.fn(() => ({})),
  } as unknown as GatewayHost;
}

describe("connectGateway disconnect messaging", () => {
  beforeEach(() => {
    mockGatewayInstances.length = 0;
  });

  it("shows actionable auth remediation text for auth disconnects", () => {
    const host = createHost();
    connectGateway(host);
    const onClose = mockGatewayInstances[0]?.opts.onClose;
    onClose?.({ code: 4008, reason: "unauthorized: gateway token mismatch" });

    expect(host.lastError).toContain("authentication failed (4008)");
    expect(host.lastError).toContain("Update token/password in Settings and reconnect.");
  });

  it("keeps service-restart disconnects suppressed (1012)", () => {
    const host = createHost();
    connectGateway(host);
    const onClose = mockGatewayInstances[0]?.opts.onClose;
    onClose?.({ code: 1012, reason: "service restart" });

    expect(host.lastError).toBeNull();
  });

  it("keeps generic disconnect messaging for non-auth disconnects", () => {
    const host = createHost();
    connectGateway(host);
    const onClose = mockGatewayInstances[0]?.opts.onClose;
    onClose?.({ code: 1006, reason: "" });

    expect(host.lastError).toBe("disconnected (1006): no reason");
  });
});
