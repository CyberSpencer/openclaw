import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import { handleGatewayRequest } from "./server-methods.js";

describe("gateway sessions.subagents contract", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it("returns task rows with expected canonical fields", async () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "verify payload",
      cleanup: "keep",
      label: "Payload task",
      model: "openai-codex/gpt-5.3-codex",
      modelApplied: true,
      routing: "explicit",
      complexity: "complex",
      rootConversationId: "conv-a",
      threadId: "thread-1",
      parentRunId: "run-parent",
      subagentGroupId: "sg-1",
      taskId: "task-1",
      createdAt: 100,
      startedAt: 110,
    });

    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "1",
        method: "sessions.subagents",
        params: {
          requesterSessionKey: "agent:main:main",
          includeCompleted: true,
          limit: 20,
        },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
      } as never,
      isWebchatConnect: false,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        count: 1,
        tasks: [
          expect.objectContaining({
            taskId: "run-1",
            runId: "run-1",
            assignedRunId: "run-1",
            childSessionKey: "agent:main:subagent:1",
            assignedSessionKey: "agent:main:subagent:1",
            status: "running",
            model: "openai-codex/gpt-5.3-codex",
            modelApplied: true,
            routing: "explicit",
            complexity: "complex",
            rootConversationId: "conv-a",
            threadId: "thread-1",
            parentRunId: "run-parent",
            subagentGroupId: "sg-1",
            taskPlanTaskId: "task-1",
          }),
        ],
      }),
      undefined,
    );
  });

  it("filters subagents by root/thread/group lineage", async () => {
    addSubagentRunForTests({
      runId: "run-allow",
      childSessionKey: "agent:main:subagent:allow",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "allow",
      cleanup: "keep",
      rootConversationId: "conv-x",
      threadId: "thread-x",
      subagentGroupId: "sg-x",
      createdAt: 200,
      startedAt: 210,
    });
    addSubagentRunForTests({
      runId: "run-deny",
      childSessionKey: "agent:main:subagent:deny",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deny",
      cleanup: "keep",
      rootConversationId: "conv-y",
      threadId: "thread-y",
      subagentGroupId: "sg-y",
      createdAt: 300,
      startedAt: 310,
    });

    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "2",
        method: "sessions.subagents",
        params: {
          requesterSessionKey: "agent:main:main",
          rootConversationId: "conv-x",
          threadId: "thread-x",
          subagentGroupId: "sg-x",
        },
      },
      respond,
      client: {
        connect: { role: "operator", scopes: ["operator.read"] },
      } as never,
      isWebchatConnect: false,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        count: 1,
        tasks: [expect.objectContaining({ runId: "run-allow" })],
      }),
      undefined,
    );
  });
});
