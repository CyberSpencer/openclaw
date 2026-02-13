import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawApp } from "./app.ts";
import { createDefaultBoard } from "./orchestrator-store.ts";
import "../styles.css";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = OpenClawApp.prototype.connect;

function mountApp(pathname: string): OpenClawApp {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  return app;
}

describe("orchestrator card launch", () => {
  beforeEach(() => {
    OpenClawApp.prototype.connect = () => {
      // no-op to avoid live gateway connections in browser test
    };
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  afterEach(() => {
    OpenClawApp.prototype.connect = originalConnect;
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  it("launches subagent cards through sessions.spawn and marks run accepted", async () => {
    const app = mountApp("/orchestrator");
    await app.updateComplete;

    const request = vi.fn(async (method: string) => {
      if (method === "sessions.spawn") {
        return {
          status: "accepted",
          childSessionKey: "agent:main:subagent:compat-1",
          runId: "run-compat-1",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    app.connected = true;
    app.sessionKey = "agent:main:main";
    app.client = { request } as unknown as OpenClawApp["client"];

    const now = Date.now();
    const board = createDefaultBoard(now);
    board.cards = [
      {
        id: "card-1",
        laneId: "backlog",
        runner: "subagent",
        title: "Spawn compatibility run",
        task: "Verify spawn accepted contract",
        agentId: "main",
        cleanup: "keep",
        createdAt: now,
        updatedAt: now,
      },
    ];
    app.orchBoards = [board];

    await app.orchRunCard("card-1");

    expect(request).toHaveBeenCalledWith(
      "sessions.spawn",
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        task: "Verify spawn accepted contract",
        label: "Spawn compatibility run",
        agentId: "main",
        cleanup: "keep",
        channel: "webchat",
      }),
    );

    const updatedCard = app.orchBoards[0]?.cards[0];
    expect(updatedCard?.laneId).toBe("running");
    expect(updatedCard?.run).toMatchObject({
      status: "accepted",
      sessionKey: "agent:main:subagent:compat-1",
      runId: "run-compat-1",
      cleanup: { mode: "keep" },
    });
  });
});
