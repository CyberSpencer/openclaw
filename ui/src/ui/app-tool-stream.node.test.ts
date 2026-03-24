import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type MutableHost = ToolStreamHost & {
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

function createHost(overrides?: Partial<MutableHost>): MutableHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    handleSpawnedRunAccepted: vi.fn(),
    ...overrides,
  };
}

describe("app-tool-stream fallback lifecycle handling", () => {
  beforeAll(() => {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    }
  });

  it("preserves delegated task assignments when an idle session receives a stale partial plan", () => {
    const host = createHost({
      chatTaskPlan: {
        id: "plan-1",
        goal: "Ship the fix",
        tasks: [
          {
            id: "task-1",
            title: "Fix the bug",
            status: "running",
            assignedSessionKey: "agent:main:subagent:worker",
            assignedRunId: "run-child",
          },
        ],
      },
    });

    handleAgentEvent(host, {
      runId: "run-main",
      seq: 3,
      stream: "orchestration",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        type: "task_plan",
        plan: {
          id: "plan-1",
          goal: "Ship the fix",
          tasks: [
            {
              id: "task-1",
              title: "Fix the bug",
              status: "todo",
            },
          ],
        },
      },
    });

    expect(host.chatTaskPlan).toEqual({
      id: "plan-1",
      goal: "Ship the fix",
      tasks: [
        {
          id: "task-1",
          title: "Fix the bug",
          status: "running",
          assignedSessionKey: "agent:main:subagent:worker",
          assignedRunId: "run-child",
        },
      ],
    });
  });

  it("still replaces the plan when the idle session receives a genuinely new plan id", () => {
    const host = createHost({
      chatTaskPlan: {
        id: "plan-1",
        goal: "Old goal",
        tasks: [
          {
            id: "task-1",
            title: "Fix the bug",
            status: "running",
            assignedSessionKey: "agent:main:subagent:worker",
          },
        ],
      },
    });

    handleAgentEvent(host, {
      runId: "run-main",
      seq: 4,
      stream: "orchestration",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        type: "task_plan",
        plan: {
          id: "plan-2",
          goal: "New goal",
          tasks: [
            {
              id: "task-2",
              title: "Verify the fix",
              status: "todo",
            },
          ],
        },
      },
    });

    expect(host.chatTaskPlan).toEqual({
      id: "plan-2",
      goal: "New goal",
      tasks: [
        {
          id: "task-2",
          title: "Verify the fix",
          status: "todo",
        },
      ],
    });
  });

  it("accepts session-scoped fallback lifecycle events when no run is active", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    expect(host.fallbackStatus?.selected).toBe("fireworks/minimax-m2p5");
    expect(host.fallbackStatus?.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(host.fallbackStatus?.reason).toBe("rate limit");
    vi.useRealTimers();
  });

  it("rejects idle fallback lifecycle events for other sessions", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:other:main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("auto-clears fallback status after toast duration", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(7_999);
    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback_cleared",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "fireworks",
        activeModel: "fireworks/minimax-m2p5",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus?.phase).toBe("cleared");
    expect(host.fallbackStatus?.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });

  it("nudges the host when sessions_spawn accepts a child run", () => {
    const handleSpawnedRunAccepted = vi.fn();
    const host = createHost({
      chatRunId: "run-main",
      handleSpawnedRunAccepted,
    });

    handleAgentEvent(host, {
      runId: "run-main",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        toolCallId: "tool-1",
        name: "sessions_spawn",
        phase: "result",
        result: {
          status: "accepted",
          childSessionKey: "agent:main:subagent:worker",
          runId: "run-child",
          mode: "run",
        },
      },
    });

    expect(handleSpawnedRunAccepted).toHaveBeenCalledWith({
      childSessionKey: "agent:main:subagent:worker",
      runId: "run-child",
      spawnMode: "run",
    });
  });
});
