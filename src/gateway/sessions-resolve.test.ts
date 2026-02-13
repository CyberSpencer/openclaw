import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSessionStoreMock = vi.fn();
const resolveGatewaySessionStoreTargetMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();
const listSessionsFromStoreMock = vi.fn();

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => loadSessionStoreMock(...args),
}));

vi.mock("./session-utils.js", () => ({
  resolveGatewaySessionStoreTarget: (...args: unknown[]) =>
    resolveGatewaySessionStoreTargetMock(...args),
  loadCombinedSessionStoreForGateway: (...args: unknown[]) =>
    loadCombinedSessionStoreForGatewayMock(...args),
  listSessionsFromStore: (...args: unknown[]) => listSessionsFromStoreMock(...args),
}));

vi.mock("../sessions/session-label.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-label.js")>();
  return {
    ...actual,
    parseSessionLabel: (label: unknown) => {
      if (typeof label !== "string" || !label.trim()) {
        return { ok: false as const, error: "invalid label" };
      }
      return { ok: true as const, label: label.trim() };
    },
  };
});

import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("resolveSessionKeyFromResolveParams strict identity", () => {
  beforeEach(() => {
    loadSessionStoreMock.mockReset();
    resolveGatewaySessionStoreTargetMock.mockReset();
    loadCombinedSessionStoreForGatewayMock.mockReset();
    listSessionsFromStoreMock.mockReset();
  });

  it("resolves a duplicate label using strict root/thread filters", () => {
    const store = {
      "agent:a:main": {
        sessionId: "s-a",
        rootConversationId: "conv-a",
        threadId: "thread-a",
      },
      "agent:b:main": {
        sessionId: "s-b",
        rootConversationId: "conv-b",
        threadId: "thread-b",
      },
    };
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/sessions.json",
      store,
    });
    listSessionsFromStoreMock.mockReturnValue({
      sessions: [
        { key: "agent:a:main", label: "work" },
        { key: "agent:b:main", label: "work" },
      ],
    });

    const result = resolveSessionKeyFromResolveParams({
      cfg: {} as never,
      p: {
        label: "work",
        strictIdentity: true,
        rootConversationId: "conv-b",
        threadId: "thread-b",
      },
    });

    expect(result).toEqual({ ok: true, key: "agent:b:main" });
  });

  it("returns identity mismatch for strict key lookup", () => {
    resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey: "main",
      storePath: "/tmp/sessions.json",
      storeKeys: ["main"],
    });
    loadSessionStoreMock.mockReturnValue({
      main: {
        sessionId: "s-main",
        rootConversationId: "conv-a",
        threadId: "thread-a",
      },
    });

    const result = resolveSessionKeyFromResolveParams({
      cfg: {} as never,
      p: {
        key: "main",
        strictIdentity: true,
        rootConversationId: "conv-b",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected strict key lookup to fail");
    }
    expect(result.error.message).toContain("identity mismatch");
  });
});
