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

    await app.reconcileInFlightOrchestratorRuns();

    const runningCard = app.orchBoards[0]?.cards.find((card) => card.id === "card-running");
    expect(runningCard?.laneId).toBe("running");
    expect(runningCard?.run?.status).toBe("running");

    const finishedCard = app.orchBoards[0]?.cards.find((card) => card.id === "card-finished");
    expect(finishedCard?.laneId).toBe("review");
    expect(finishedCard?.run?.status).toBe("done");
  });
});
