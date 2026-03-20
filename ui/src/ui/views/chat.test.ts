/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
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
    const container = document.createElement("div");
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
  });
});

describe("chat orchestration subagent model labels", () => {
  it("shows the resolved provider/model instead of the routing hint", () => {
    const container = document.createElement("div");
    const subagents = createSessions();
    subagents.sessions = [
      {
        key: "agent:main:subagent:model-1",
        kind: "direct",
        label: "Fast code worker",
        displayName: "Fast code worker",
        derivedTitle: "Implement the fix",
        task: "Implement the fix",
        updatedAt: 1_500,
        runStatus: "running",
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        routing: "explicit",
      },
    ];
    subagents.count = 1;
    subagents.total = 1;
    subagents.limit = 1;

    render(
      renderChat(
        createProps({
          subagentMonitorResult: subagents,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("openai-codex/gpt-5.3-codex-spark");
    expect(container.textContent).toContain("route:explicit");
    expect(container.textContent).toContain("lane:subagent");
  });
});

describe("chat terminal steer affordance", () => {
  it("shows Send when only subagents are active", () => {
    const container = document.createElement("div");
    const subagents = createSessions();
    subagents.sessions = [
      {
        key: "agent:main:subagent:1",
        kind: "direct",
        label: "Worker",
        updatedAt: Date.now(),
        runStatus: "running",
      },
    ];

    render(
      renderChat(
        createProps({
          subagentMonitorResult: subagents,
          runActive: false,
          canSteer: false,
        }),
      ),
      container,
    );

    const primaryButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Send"),
    );
    expect(primaryButton).not.toBeUndefined();
    expect(container.textContent).not.toContain("Steer");
  });

  it("shows Queue when the main run is active but not steerable", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          runActive: true,
          canSteer: false,
        }),
      ),
      container,
    );

    const primaryButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Queue"),
    );
    expect(primaryButton).not.toBeUndefined();
    expect(container.textContent).not.toContain("Steer");
  });
});
