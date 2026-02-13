import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => ({
    execute: vi.fn(async () => ({
      details: {
        status: "accepted",
        childSessionKey: "agent:main:subagent:test-child",
        runId: "run-test-child",
      },
    })),
  }),
}));

describe("gateway sessions.spawn dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns accepted payload from sessions.spawn handler", async () => {
    const { handleGatewayRequest } = await import("./server-methods.js");
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "sessions.spawn",
        params: {
          requesterSessionKey: "main",
          task: "do a thing",
        },
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
      expect.objectContaining({
        status: "accepted",
        childSessionKey: "agent:main:subagent:test-child",
        runId: "run-test-child",
      }),
      undefined,
    );
  });
});
