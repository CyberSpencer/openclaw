import { parseHTML } from "linkedom";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { createDefaultBoard } from "../orchestrator-store.ts";
import { renderOrchestrator } from "./orchestrator.ts";

function createDomContainer(): HTMLElement {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window,
    document,
    customElements: window.customElements,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
  });
  return document.createElement("div") as unknown as HTMLElement;
}

function createState(selectedCardId: string): AppViewState {
  const now = Date.now();
  const board = createDefaultBoard(now);
  board.cards = [
    {
      id: "card-running",
      laneId: "running",
      runner: "subagent",
      title: "Running card",
      task: "Keep working",
      agentId: "main",
      cleanup: "keep",
      createdAt: now,
      updatedAt: now,
      run: {
        runId: "run-running",
        sessionKey: "agent:main:subagent:running",
        status: "running",
        createdAt: now,
        startedAt: now,
      },
    },
    {
      id: "card-done",
      laneId: "done",
      runner: "subagent",
      title: "Done card",
      task: "All set",
      agentId: "main",
      cleanup: "keep",
      createdAt: now,
      updatedAt: now,
      run: {
        runId: "run-done",
        sessionKey: "agent:main:subagent:done",
        status: "done",
        createdAt: now,
        startedAt: now,
        endedAt: now,
      },
    },
  ];

  return {
    connected: true,
    agentsList: { agents: [{ id: "main", name: "Main" }] },
    orchBoards: [board],
    orchSelectedBoardId: board.id,
    orchSelectedCardId: selectedCardId,
    orchDragOverLaneId: null,
    orchBusyCardId: null,
    orchTemplateQuery: "",
    orchDraft: {
      title: "",
      task: "",
      agentId: "main",
      runner: "subagent",
      model: "",
      thinking: "",
      timeoutSeconds: "",
      cleanup: "keep",
      codexMode: "apply",
      codexShellAllowlist: "",
      showAdvanced: false,
    },
    orchSelectCard: vi.fn(),
    orchCreateCard: vi.fn(),
    orchUpdateCard: vi.fn(),
    orchMoveCard: vi.fn(),
    orchDeleteCard: vi.fn(),
    orchDuplicateCard: vi.fn(),
    orchRunCard: vi.fn(async () => undefined),
    orchCleanupCardSession: vi.fn(async () => undefined),
    orchSetDraft: vi.fn(),
    orchAddDraftCard: vi.fn(async () => undefined),
    openChatSession: vi.fn(),
  } as unknown as AppViewState;
}

function findCard(container: HTMLElement, title: string): HTMLElement {
  const card = Array.from(container.querySelectorAll<HTMLElement>(".orch-card")).find((node) =>
    node.querySelector(".orch-card-title")?.textContent?.includes(title),
  );
  expect(card).toBeTruthy();
  return card as HTMLElement;
}

describe("orchestrator view", () => {
  it("uses distinct status dots for active and completed runs", async () => {
    const container = createDomContainer();
    render(renderOrchestrator(createState("card-running")), container);
    await Promise.resolve();

    const runningCard = findCard(container, "Running card");
    const doneCard = findCard(container, "Done card");

    const runningStatusDot = runningCard.querySelector(
      '.orch-badge[title="Run status"] .statusDot',
    );
    const doneStatusDot = doneCard.querySelector('.orch-badge[title="Run status"] .statusDot');

    expect(runningStatusDot?.className).toContain("active");
    expect(runningStatusDot?.className).not.toContain("ok");
    expect(doneStatusDot?.className).toContain("ok");
    expect(doneStatusDot?.className).not.toContain("active");

    const runningInspectorDot = container.querySelector(".orch-side .pill .statusDot");
    expect(runningInspectorDot?.className).toContain("active");
    expect(runningInspectorDot?.className).not.toContain("ok");

    render(renderOrchestrator(createState("card-done")), container);
    await Promise.resolve();

    const doneInspectorDot = container.querySelector(".orch-side .pill .statusDot");
    expect(doneInspectorDot?.className).toContain("ok");
    expect(doneInspectorDot?.className).not.toContain("active");
  });
});
