import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderChatThreadsNav, type ChatThreadsNavProps } from "./chat-threads-nav.ts";

function buildSessions(
  count: number,
  overrides: Partial<SessionsListResult> = {},
): SessionsListResult {
  const sessions = Array.from({ length: count }, (_, idx) => ({
    key: `agent:main:chat:${idx + 1}`,
    kind: "direct" as const,
    updatedAt: Date.now() - idx * 1_000,
    derivedTitle: `Chat ${idx + 1}`,
  }));
  return {
    ts: Date.now(),
    path: "/tmp/sessions.json",
    count: sessions.length,
    total: sessions.length,
    limit: sessions.length,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    defaults: { model: null, contextTokens: null },
    sessions,
    ...overrides,
  };
}

function createProps(overrides: Partial<ChatThreadsNavProps> = {}): ChatThreadsNavProps {
  return {
    connected: true,
    onboarding: false,
    showThinking: false,
    focusMode: false,
    loading: false,
    loadingMore: false,
    error: null,
    sessions: buildSessions(3),
    activeSessionKey: "agent:main:chat:1",
    query: "",
    showSubagents: false,
    onNewChat: () => undefined,
    onSelectChat: () => undefined,
    onQueryChange: () => undefined,
    onToggleSubagents: () => undefined,
    onRenameChat: () => undefined,
    onDeleteChat: () => undefined,
    onRefresh: () => undefined,
    onLoadMore: () => undefined,
    onToggleThinking: () => undefined,
    onToggleFocusMode: () => undefined,
    ...overrides,
  };
}

describe("chat threads nav", () => {
  it("shows a truthful load older chats button and invokes onLoadMore", () => {
    const container = document.createElement("div");
    const onLoadMore = vi.fn();
    render(
      renderChatThreadsNav(
        createProps({
          sessions: buildSessions(80, {
            total: 160,
            limit: 80,
            hasMore: true,
            nextOffset: 80,
          }),
          onLoadMore,
        }),
      ),
      container,
    );

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Load older chats"),
    );
    expect(button?.textContent).toContain("80 remaining");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("renders appended older chats and allows selecting them", () => {
    const container = document.createElement("div");
    const onSelectChat = vi.fn();
    render(
      renderChatThreadsNav(
        createProps({
          sessions: buildSessions(160, {
            total: 160,
            limit: 160,
          }),
          activeSessionKey: "agent:main:chat:1",
          onSelectChat,
        }),
      ),
      container,
    );

    const oldest = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.getAttribute("aria-label") === "Open chat: Chat 160",
    );
    expect(oldest).not.toBeUndefined();
    oldest?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectChat).toHaveBeenCalledWith("agent:main:chat:160");
  });
});
