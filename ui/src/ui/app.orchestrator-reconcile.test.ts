import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawApp } from "./app.ts";
import { createDefaultBoard } from "./orchestrator-store.ts";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = OpenClawApp.prototype.connect;

function mountApp(pathname: string): OpenClawApp {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  return app;
}

describe("orchestrator reconnect reconciliation", () => {
  beforeEach(() => {
    OpenClawApp.prototype.connect = () => {
      // no-op
    };
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  afterEach(() => {
    OpenClawApp.prototype.connect = originalConnect;
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  it("rehydrates in-flight runs and finalizes completed runs", async () => {
    const app = mountApp("/orchestrator");
    await app.updateComplete;

    const now = Date.now();
    const board = createDefaultBoard(now);
    board.cards = [
      {
        id: "card-running",
        laneId: "backlog",
        title: "running",
        task: "running task",
        agentId: "main",
        createdAt: now,
        updatedAt: now,
        run: {
          runId: "run-running",
          sessionKey: "agent:main:subagent:running",
          status: "accepted",
          createdAt: now,
        },
      },
      {
        id: "card-finished",
        laneId: "running",
        title: "finished",
        task: "finished task",
        agentId: "main",
        createdAt: now,
        updatedAt: now,
        run: {
          runId: "run-finished",
          sessionKey: "agent:main:subagent:finished",
          status: "running",
          error: "old failure",
          createdAt: now,
        },
      },
    ];

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.subagents") {
        expect(params).toMatchObject({ requesterSessionKey: "agent:main:main" });
        return {
          tasks: [
            {
              runId: "run-running",
              childSessionKey: "agent:main:subagent:running",
              status: "running",
              startedAt: now + 100,
            },
          ],
        };
      }
      if (method === "agent.wait") {
        if (params.runId === "run-finished") {
          return {
            runId: "run-finished",
            status: "ok",
            startedAt: now + 50,
            endedAt: now + 500,
          };
        }
        return null;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    app.connected = true;
    app.sessionKey = "agent:main:main";
    app.client = { request } as unknown as OpenClawApp["client"];
    app.orchBoards = [board];

    const result = await app.reconcileInFlightOrchestratorRuns();

    const runningCard = app.orchBoards[0]?.cards.find((card) => card.id === "card-running");
    expect(runningCard?.laneId).toBe("running");
    expect(runningCard?.run?.status).toBe("running");

    const finishedCard = app.orchBoards[0]?.cards.find((card) => card.id === "card-finished");
    expect(finishedCard?.laneId).toBe("review");
    expect(finishedCard?.run?.status).toBe("done");
    expect(finishedCard?.run?.error).toBeUndefined();
    expect(result.activeSessionKeys).toEqual(["agent:main:subagent:running"]);
  });

  it("marks reconciliation as degraded when sessions.subagents is unavailable", async () => {
    const app = mountApp("/orchestrator");
    await app.updateComplete;

    const now = Date.now();
    const board = createDefaultBoard(now);
    board.cards = [
      {
        id: "card-accepted",
        laneId: "backlog",
        title: "accepted",
        task: "accepted task",
        agentId: "main",
        createdAt: now,
        updatedAt: now,
        run: {
          runId: "run-accepted",
          sessionKey: "agent:main:subagent:accepted",
          status: "accepted",
          createdAt: now,
        },
      },
    ];

    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subagents") {
        throw new Error("unknown method: sessions.subagents");
      }
      if (method === "agent.wait") {
        return null;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    app.connected = true;
    app.sessionKey = "agent:main:main";
    app.client = { request } as unknown as OpenClawApp["client"];
    app.orchBoards = [board];
    app.lastError = null;

    const result = await app.reconcileInFlightOrchestratorRuns();

    expect(app.lastError).toContain("orchestrator reconciliation degraded");
    expect(result.activeSessionKeys).toEqual(["agent:main:subagent:accepted"]);
    const acceptedCard = app.orchBoards[0]?.cards.find((card) => card.id === "card-accepted");
    expect(acceptedCard?.laneId).toBe("running");
    expect(acceptedCard?.run?.status).toBe("running");
  });

  it("issues agent.wait probes in parallel for unresolved runs", async () => {
    const app = mountApp("/orchestrator");
    await app.updateComplete;

    const now = Date.now();
    const board = createDefaultBoard(now);
    board.cards = [
      {
        id: "card-a",
        laneId: "backlog",
        title: "A",
        task: "task A",
        agentId: "main",
        createdAt: now,
        updatedAt: now,
        run: {
          runId: "run-a",
          sessionKey: "agent:main:subagent:a",
          status: "accepted",
          createdAt: now,
        },
      },
      {
        id: "card-b",
        laneId: "backlog",
        title: "B",
        task: "task B",
        agentId: "main",
        createdAt: now,
        updatedAt: now,
        run: {
          runId: "run-b",
          sessionKey: "agent:main:subagent:b",
          status: "accepted",
          createdAt: now,
        },
      },
    ];

    const waitResolvers = new Map<string, (value: unknown) => void>();
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "sessions.subagents") {
        return Promise.resolve({ tasks: [] });
      }
      if (method === "agent.wait") {
        const runId = String(params.runId ?? "");
        return new Promise((resolve) => {
          waitResolvers.set(runId, resolve);
        });
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });

    app.connected = true;
    app.sessionKey = "agent:main:main";
    app.client = { request } as unknown as OpenClawApp["client"];
    app.orchBoards = [board];

    const reconcilePromise = app.reconcileInFlightOrchestratorRuns();
    await Promise.resolve();
    await Promise.resolve();

    expect(waitResolvers.size).toBe(2);

    waitResolvers.get("run-a")?.({
      runId: "run-a",
      status: "ok",
      startedAt: now + 10,
      endedAt: now + 100,
    });
    waitResolvers.get("run-b")?.({
      runId: "run-b",
      status: "ok",
      startedAt: now + 20,
      endedAt: now + 120,
    });
    await reconcilePromise;

    const cardA = app.orchBoards[0]?.cards.find((card) => card.id === "card-a");
    const cardB = app.orchBoards[0]?.cards.find((card) => card.id === "card-b");
    expect(cardA?.run?.status).toBe("done");
    expect(cardB?.run?.status).toBe("done");
  });
});
