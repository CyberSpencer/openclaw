import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawApp } from "./app.ts";
import { createDefaultBoard, type OrchestrationBoard } from "./orchestrator-store.ts";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = OpenClawApp.prototype.connect;

function mountApp(pathname: string): OpenClawApp {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  return app;
}

function boardWithCard(cardId: string): OrchestrationBoard {
  const now = Date.now();
  const board = createDefaultBoard(now);
  board.cards = [
    {
      id: cardId,
      laneId: "backlog",
      title: `Card ${cardId}`,
      task: `Task ${cardId}`,
      agentId: "main",
      createdAt: now,
      updatedAt: now,
    },
  ];
  return board;
}

describe("orchestrator scoped board sync", () => {
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

  it("loads/syncs orchestrator state for the active session scope", async () => {
    const app = mountApp("/orchestrator");
    await app.updateComplete;

    const request = vi.fn(async (method: string) => {
      if (method === "orchestrator.get") {
        return {
          exists: true,
          hash: "hash-a",
          scopeKey: "root-a",
          state: {
            version: 1,
            selectedBoardId: "main",
            boards: [boardWithCard("card-a")],
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    app.connected = true;
    app.sessionKey = "agent:main:main";
    app.client = { request } as unknown as OpenClawApp["client"];

    await app.loadOrchestratorFromGateway();

    expect(request).toHaveBeenCalledWith("orchestrator.get", {
      sessionKey: "agent:main:main",
    });
    expect(app.orchBoards[0]?.cards[0]?.id).toBe("card-a");

    app.handleOrchestratorStoreEvent({
      scopeKey: "root-b",
      hash: "hash-b",
      state: {
        version: 1,
        selectedBoardId: "main",
        boards: [boardWithCard("card-b")],
      },
    });

    // Different scope should be ignored.
    expect(app.orchBoards[0]?.cards[0]?.id).toBe("card-a");

    app.handleOrchestratorStoreEvent({
      scopeKey: "root-a",
      hash: "hash-c",
      state: {
        version: 1,
        selectedBoardId: "main",
        boards: [boardWithCard("card-c")],
      },
    });

    expect(app.orchBoards[0]?.cards[0]?.id).toBe("card-c");
  });
});
