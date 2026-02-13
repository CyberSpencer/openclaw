import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGateway, emitAgentEvent } = vi.hoisted(() => ({
  callGateway: vi.fn(),
  emitAgentEvent: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway,
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent,
}));

import { createOrchestrationPlanTool } from "./orchestration-plan-tool.js";

describe("orchestration_plan auto-delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns subagents for unassigned todo tasks and patches delegated plan", async () => {
    callGateway.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "sessions.spawn") {
          return {
            status: "accepted",
            childSessionKey: "agent:main:subagent:42",
            runId: "run-child-42",
          };
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    );

    const tool = createOrchestrationPlanTool({
      agentSessionKey: "agent:main:main",
      agentRunId: "run-parent-1",
    });

    const result = await tool.execute("toolcall-orch", {
      action: "set",
      plan: {
        id: "plan-1",
        goal: "Ship compatibility suite",
        tasks: [
          { id: "t1", title: "Add compatibility tests", status: "todo" },
          {
            id: "t2",
            title: "Already assigned",
            status: "todo",
            assignedSessionKey: "agent:main:subagent:existing",
          },
        ],
      },
    });

    const details = result.details as {
      status: string;
      delegated: Array<{ taskId: string; childSessionKey: string; runId: string }>;
      plan: {
        id: string;
        tasks: Array<{
          id: string;
          status?: string;
          assignedSessionKey?: string;
          assignedRunId?: string;
        }>;
      };
    };

    expect(details.status).toBe("ok");
    expect(details.delegated).toEqual([
      {
        taskId: "t1",
        childSessionKey: "agent:main:subagent:42",
        runId: "run-child-42",
      },
    ]);

    const delegatedTask = details.plan.tasks.find((task) => task.id === "t1");
    expect(delegatedTask).toMatchObject({
      status: "running",
      assignedSessionKey: "agent:main:subagent:42",
      assignedRunId: "run-child-42",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.spawn",
        params: expect.objectContaining({
          requesterSessionKey: "agent:main:main",
          task: "Add compatibility tests",
          label: "Add compatibility tests",
          idempotencyKey: "run-parent-1:plan-1:t1",
        }),
      }),
    );

    const patchCalls = callGateway.mock.calls
      .map((call) => call[0])
      .filter((req) => req?.method === "sessions.patch");
    expect(patchCalls).toHaveLength(2);

    expect(emitAgentEvent).toHaveBeenCalledTimes(2);
  });
});
