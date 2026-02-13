import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import { handleGatewayRequest } from "./server-methods.js";

describe("sessions.patch lineage warnings", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it("warns when task plan assignments mix rootConversationIds", async () => {
    addSubagentRunForTests({
      runId: "run-a",
      childSessionKey: "agent:main:subagent:a",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "a",
      cleanup: "keep",
      rootConversationId: "conv-a",
      threadId: "thread-1",
      createdAt: 1,
      startedAt: 2,
    });

    addSubagentRunForTests({
      runId: "run-b",
      childSessionKey: "agent:main:subagent:b",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "b",
      cleanup: "keep",
      rootConversationId: "conv-b",
      threadId: "thread-1",
      createdAt: 3,
      startedAt: 4,
    });

    const respond = vi.fn();
    const warn = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "sessions.patch",
        params: {
          key: "agent:main:main",
          taskPlan: {
            id: "plan-1",
            tasks: [
              {
                id: "t1",
                title: "task-a",
                status: "running",
                assignedRunId: "run-a",
              },
              {
                id: "t2",
                title: "task-b",
                status: "running",
                assignedRunId: "run-b",
              },
            ],
          },
        },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.admin"] },
      } as never,
      isWebchatConnect: false,
      context: {
        logGateway: { warn },
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("task_plan_lineage_mixed_root"));
  });
});
