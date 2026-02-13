import { beforeEach, describe, expect, it } from "vitest";
import { loadOrchestratorState } from "./orchestrator-store.ts";

describe("orchestrator-store scope migration", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
  });

  it("migrates legacy unscoped main key into scoped key", () => {
    const legacyKey = "openclaw.control.orchestrator.v1";
    const scopedMainKey = "openclaw.control.orchestrator.v1:main";
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        selectedBoardId: "main",
        boards: [
          {
            id: "main",
            title: "Mission Control",
            lanes: [{ id: "backlog", title: "Backlog" }],
            cards: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );

    const state = loadOrchestratorState();

    expect(state.selectedBoardId).toBe("main");
    expect(localStorage.getItem(scopedMainKey)).toBeTruthy();
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });
});
