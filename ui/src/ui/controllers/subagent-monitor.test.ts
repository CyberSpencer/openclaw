import { describe, expect, it, vi } from "vitest";
import { loadSubagentMonitor, type SubagentMonitorState } from "./subagent-monitor.ts";

function createState(overrides?: Partial<SubagentMonitorState>): SubagentMonitorState {
  return {
    client: null,
    connected: true,
    sessionKey: "agent:main:main",
    subagentMonitorLoading: false,
    subagentMonitorResult: null,
    subagentMonitorError: null,
    ...overrides,
  };
}

describe("loadSubagentMonitor", () => {
  it("calls sessions.subagents and maps rows into SessionsListResult shape", async () => {
    const request = vi.fn().mockResolvedValue({
      ts: 123,
      tasks: [
        {
          childSessionKey: "agent:main:subagent:abc",
          label: "Task A",
          task: "Do A",
          runId: "run-a",
          status: "running",
          createdAt: 100,
          startedAt: 110,
        },
      ],
    });
    const state = createState({
      client: { request } as unknown as SubagentMonitorState["client"],
      sessionKey: "agent:main:main",
    });

    await loadSubagentMonitor(state, { limit: 10 });

    expect(request).toHaveBeenCalledWith("sessions.subagents", {
      requesterSessionKey: "agent:main:main",
      includeCompleted: true,
      limit: 10,
    });
    expect(state.subagentMonitorResult?.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:subagent:abc",
        label: "Task A",
        derivedTitle: "Do A",
        updatedAt: 110,
        sessionId: "run-a",
      }),
    ]);
  });

  it("falls back to sessions.list when sessions.subagents fails", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("unknown method: sessions.subagents"))
      .mockResolvedValueOnce({
        ts: 456,
        path: "(legacy)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:subagent:legacy", kind: "direct", updatedAt: 200 }],
      });
    const state = createState({
      client: { request } as unknown as SubagentMonitorState["client"],
      sessionKey: "agent:main:main",
    });

    await loadSubagentMonitor(state, { limit: 5 });

    expect(request).toHaveBeenNthCalledWith(1, "sessions.subagents", {
      requesterSessionKey: "agent:main:main",
      includeCompleted: true,
      limit: 5,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: true,
      spawnedBy: "agent:main:main",
      limit: 5,
    });
    expect(state.subagentMonitorResult?.sessions[0]?.key).toBe("agent:main:subagent:legacy");
  });

  it("skips when disconnected", async () => {
    const request = vi.fn();
    const state = createState({
      connected: false,
      client: { request } as unknown as SubagentMonitorState["client"],
    });

    await loadSubagentMonitor(state);

    expect(request).not.toHaveBeenCalled();
  });
});
