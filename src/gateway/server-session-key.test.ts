import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../routing/session-key.js", () => ({
  toAgentRequestSessionKey: vi.fn((key: string) => key),
}));

import { loadConfig } from "../config/config.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

describe("resolveSessionKeyForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgentRunContext).mockReturnValue(undefined);
    vi.mocked(toAgentRequestSessionKey).mockImplementation((key) => key);
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });
  });

  it("returns cached session keys without scanning stores", () => {
    vi.mocked(getAgentRunContext).mockReturnValue({
      sessionKey: "agent:main:main",
    });

    expect(resolveSessionKeyForRun("run-cached")).toBe("agent:main:main");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(loadCombinedSessionStoreForGateway).not.toHaveBeenCalled();
  });

  it("resolves runs from the combined gateway session store", () => {
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:review:main": {
          sessionId: "run-review",
          updatedAt: Date.now(),
        },
      },
    });
    vi.mocked(toAgentRequestSessionKey).mockReturnValue("agent:review:main");

    expect(resolveSessionKeyForRun("run-review")).toBe("agent:review:main");
    expect(loadCombinedSessionStoreForGateway).toHaveBeenCalledTimes(1);
    expect(registerAgentRunContext).toHaveBeenCalledWith("run-review", {
      sessionKey: "agent:review:main",
    });
  });
});
