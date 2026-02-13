import { describe, expect, test } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";

describe("agent-events sequencing", () => {
  test("stores and clears run context", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("propagates identity envelope fields from run context", async () => {
    let seen:
      | {
          rootConversationId?: string;
          threadId?: string;
          parentRunId?: string;
          subagentGroupId?: string;
          taskId?: string;
          requesterSessionKey?: string;
          spawnedBySessionKey?: string;
        }
      | undefined;

    registerAgentRunContext("run-env", {
      sessionKey: "main",
      rootConversationId: "conv-1",
      threadId: "thread-1",
      parentRunId: "run-parent",
      subagentGroupId: "sg-1",
      taskId: "task-1",
      requesterSessionKey: "main",
      spawnedBySessionKey: "agent:main:sub",
    });

    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-env") {
        return;
      }
      seen = {
        rootConversationId: evt.rootConversationId,
        threadId: evt.threadId,
        parentRunId: evt.parentRunId,
        subagentGroupId: evt.subagentGroupId,
        taskId: evt.taskId,
        requesterSessionKey: evt.requesterSessionKey,
        spawnedBySessionKey: evt.spawnedBySessionKey,
      };
    });

    emitAgentEvent({ runId: "run-env", stream: "lifecycle", data: {} });
    stop();

    expect(seen).toEqual({
      rootConversationId: "conv-1",
      threadId: "thread-1",
      parentRunId: "run-parent",
      subagentGroupId: "sg-1",
      taskId: "task-1",
      requesterSessionKey: "main",
      spawnedBySessionKey: "agent:main:sub",
    });
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });
});
