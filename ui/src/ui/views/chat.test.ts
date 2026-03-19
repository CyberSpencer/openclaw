import { parseHTML } from "linkedom";
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    total: 0,
    limit: 0,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    defaults: { model: null, contextTokens: null },
    sessions: [],
  };
}

const GLOBAL_KEYS = [
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "DocumentFragment",
  "ShadowRoot",
] as const;

const originalGlobals = new Map<string, unknown>();

function createDomContainer(): HTMLElement {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  for (const key of GLOBAL_KEYS) {
    if (!originalGlobals.has(key)) {
      originalGlobals.set(key, (globalThis as Record<string, unknown>)[key]);
    }
  }
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

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    const value = originalGlobals.get(key);
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
});

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewChat: () => undefined,
    ...overrides,
  };
}

describe("chat orchestration status reconciliation", () => {
  it("uses terminal subagent status instead of stale running task-plan status", () => {
    const container = createDomContainer();
    const subagents = createSessions();
    subagents.sessions = [
      {
        key: "agent:main:subagent:done-1",
        kind: "direct",
        label: "Done agent",
        displayName: "Done agent",
        derivedTitle: "Fix the bug",
        task: "Fix the bug",
        updatedAt: 1_500,
        runStatus: "done",
      },
    ];
    subagents.count = 1;
    subagents.total = 1;
    subagents.limit = 1;

    render(
      renderChat(
        createProps({
          taskPlan: {
            id: "plan-1",
            goal: "Ship the fix",
            tasks: [
              {
                id: "task-1",
                title: "Fix the bug",
                status: "running",
                assignedSessionKey: "agent:main:subagent:done-1",
              },
            ],
          },
          subagentMonitorResult: subagents,
        }),
      ),
      container,
    );

    expect(container.querySelector(".agent-task--done")).not.toBeNull();
    expect(container.querySelector(".agent-task--running")).toBeNull();
    expect(container.querySelector(".agent-subagent--running")).toBeNull();
    expect(container.textContent).toContain("1/1");
    const progressBar = container.querySelector('[role="progressbar"]');
    expect(progressBar?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("disables assigned task chips for non-openable background agents without marking them pruned", () => {
    const container = createDomContainer();
    const subagents = createSessions();
    subagents.sessions = [
      {
        key: "process:proc-codex",
        kind: "direct",
        label: "Codex background agent",
        displayName: "Codex background agent",
        derivedTitle: 'codex exec --full-auto "fix it"',
        task: 'codex exec --full-auto "fix it"',
        updatedAt: 1_500,
        runStatus: "running",
        source: "background-exec",
        openable: false,
      },
    ];
    subagents.count = 1;
    subagents.total = 1;
    subagents.limit = 1;

    render(
      renderChat(
        createProps({
          taskPlan: {
            id: "plan-2",
            goal: "Ship the fix",
            tasks: [
              {
                id: "task-2",
                title: "Background review",
                status: "running",
                assignedSessionKey: "process:proc-codex",
              },
            ],
          },
          subagentMonitorResult: subagents,
        }),
      ),
      container,
    );

    const assignedButton = container.querySelector(".agent-task__assigned");
    expect(assignedButton?.disabled).toBe(true);
    expect(assignedButton?.getAttribute("title")).toBe(
      "Assigned agent is a background coding agent",
    );
    expect(container.textContent).not.toContain("(pruned)");
  });
});
