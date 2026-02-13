import { afterEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn(async () => ({
  details: {
    status: "accepted",
    childSessionKey: "agent:main:subagent:test-child",
    runId: "run-test-child",
  },
}));

vi.mock("../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => ({
    execute: executeMock,
  }),
}));

describe("gateway sessions.spawn dispatch", () => {
  afterEach(() => {
    executeMock.mockClear();
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
          idempotencyKey: "spawn-fixed-1",
          parentRunId: "run-parent-1",
          subagentGroupId: "sg-1",
          taskId: "task-1",
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
    expect(executeMock).toHaveBeenCalledWith(
      "gateway.sessions.spawn",
      expect.objectContaining({
        task: "do a thing",
        idempotencyKey: "spawn-fixed-1",
        parentRunId: "run-parent-1",
        subagentGroupId: "sg-1",
        taskId: "task-1",
      }),
    );
  });
});
