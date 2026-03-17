import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSessionStoreMock, isEmbeddedPiRunActiveMock, queueEmbeddedPiMessageMock } = vi.hoisted(
  () => ({
    loadSessionStoreMock: vi.fn(() => ({})),
    isEmbeddedPiRunActiveMock: vi.fn(() => false),
    queueEmbeddedPiMessageMock: vi.fn(() => false),
  }),
);

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: GatewayCall) => {
    gatewayCalls.push(request);
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    }),
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions-main.json",
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: isEmbeddedPiRunActiveMock,
  queueEmbeddedPiMessage: queueEmbeddedPiMessageMock,
  waitForEmbeddedPiRunEnd: async () => true,
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => true,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
  resolveRequesterForChildSession: () => null,
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

describe("runSubagentAnnounceFlow webchat completion delivery", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({});
    isEmbeddedPiRunActiveMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReturnValue(false);
    queueEmbeddedPiMessageMock.mockReset();
    queueEmbeddedPiMessageMock.mockReturnValue(false);
  });

  it("keeps completion-mode webchat announces inside the requester session", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-webchat-completion",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "webchat",
        to: "session:webchat-main",
      },
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "done",
      expectsCompletionMessage: true,
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    expect(
      gatewayCalls.find(
        (call) =>
          call.method === "agent" &&
          call.expectFinal === true &&
          call.params?.sessionKey === "agent:main:main" &&
          call.params?.deliver === false,
      ),
    ).toBeDefined();
  });

  it("queues internal webchat completion announces when the requester session is active", async () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        sessionId: "sess-main",
        channel: "webchat",
        lastChannel: "webchat",
      },
    });
    isEmbeddedPiRunActiveMock.mockReturnValue(true);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-webchat-active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "webchat",
      },
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep",
      roundOneReply: "done",
      expectsCompletionMessage: true,
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    expect(
      gatewayCalls.find(
        (call) =>
          call.method === "agent" &&
          call.expectFinal === true &&
          call.params?.sessionKey === "agent:main:main" &&
          call.params?.deliver === false,
      ),
    ).toBeDefined();
  });
});
