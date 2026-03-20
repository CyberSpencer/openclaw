import { describe, expect, it, vi } from "vitest";
import { CHAT_THREADS_PAGE_SIZE, loadChatThreads, type ChatThreadsState } from "./chat-threads.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function buildResult(
  sessions: Array<{ key: string; updatedAt?: number | null }>,
  overrides: Partial<NonNullable<ChatThreadsState["chatThreadsResult"]>> = {},
) {
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
    sessions: sessions.map((session) => ({
      kind: "direct" as const,
      updatedAt: Date.now(),
      ...session,
    })),
    ...overrides,
  };
}

function createState(
  request: RequestFn,
  overrides: Partial<ChatThreadsState> = {},
): ChatThreadsState {
  return {
    client: { request } as unknown as ChatThreadsState["client"],
    connected: true,
    chatThreadsLoading: false,
    chatThreadsLoadingMore: false,
    chatThreadsResult: null,
    chatThreadsError: null,
    chatThreadsShowSubagents: false,
    chatThreadsQueuedLoad: null,
    ...overrides,
  };
}

describe("loadChatThreads", () => {
  it("loads the direct chat page with paging params", async () => {
    const result = buildResult([{ key: "agent:main:chat:a" }], {
      count: 1,
      total: 2,
      limit: CHAT_THREADS_PAGE_SIZE,
      offset: 0,
      hasMore: true,
      nextOffset: 1,
    });
    const request = vi.fn(async () => result);
    const state = createState(request, { chatThreadsShowSubagents: false });

    await loadChatThreads(state, { search: "  alpha  " });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      includeSubagents: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      kind: "direct",
      limit: CHAT_THREADS_PAGE_SIZE,
      offset: 0,
      search: "alpha",
    });
    expect(state.chatThreadsResult).toEqual(result);
    expect(state.chatThreadsLoading).toBe(false);
    expect(state.chatThreadsLoadingMore).toBe(false);
  });

  it("appends older chat pages without duplicating rows", async () => {
    const firstPageSessions = Array.from({ length: 80 }, (_, idx) => ({
      key: `agent:main:chat:${idx + 1}`,
    }));
    const secondPageSessions = Array.from({ length: 80 }, (_, idx) => ({
      key: `agent:main:chat:${idx + 81}`,
    }));
    const request = vi.fn(async () =>
      buildResult(secondPageSessions, {
        count: 80,
        total: 160,
        limit: 80,
        offset: 80,
        hasMore: false,
        nextOffset: null,
      }),
    );
    const state = createState(request, {
      chatThreadsResult: buildResult(firstPageSessions, {
        count: 80,
        total: 160,
        limit: 80,
        offset: 0,
        hasMore: true,
        nextOffset: 80,
      }),
    });

    await loadChatThreads(state, { mode: "append" });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      includeSubagents: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      kind: "direct",
      limit: CHAT_THREADS_PAGE_SIZE,
      offset: 80,
    });
    expect(state.chatThreadsResult?.sessions).toHaveLength(160);
    expect(state.chatThreadsResult?.sessions[159]?.key).toBe("agent:main:chat:160");
    expect(state.chatThreadsResult?.count).toBe(160);
    expect(state.chatThreadsResult?.limit).toBe(160);
    expect(state.chatThreadsResult?.total).toBe(160);
    expect(state.chatThreadsResult?.hasMore).toBe(false);
    expect(state.chatThreadsLoadingMore).toBe(false);
  });

  it("preserves loaded depth on refresh-style loads", async () => {
    const result = buildResult(
      [{ key: "agent:main:chat:a" }, { key: "agent:main:chat:b" }, { key: "agent:main:chat:c" }],
      {
        count: 3,
        total: 6,
        limit: 3,
        offset: 0,
        hasMore: true,
        nextOffset: 3,
      },
    );
    const request = vi.fn(async () => result);
    const state = createState(request, {
      chatThreadsShowSubagents: true,
      chatThreadsResult: result,
    });

    await loadChatThreads(state, { mode: "preserve" });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      includeSubagents: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
      kind: "direct",
      limit: 3,
      offset: 0,
    });
    expect(state.chatThreadsResult).toEqual(result);
  });

  it("queues the latest reset-style load while append is in flight", async () => {
    let resolveAppend:
      | ((value: NonNullable<ChatThreadsState["chatThreadsResult"]>) => void)
      | null = null;
    const appendResult = buildResult([{ key: "agent:main:chat:81" }], {
      count: 1,
      total: 81,
      limit: 1,
      offset: 80,
      hasMore: false,
      nextOffset: null,
    });
    const resetResult = buildResult([{ key: "agent:main:chat:filtered" }], {
      count: 1,
      total: 1,
      limit: CHAT_THREADS_PAGE_SIZE,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.offset === 80) {
        return await new Promise<typeof appendResult>((resolve) => {
          resolveAppend = resolve;
        });
      }
      return resetResult;
    });
    const state = createState(request, {
      chatThreadsResult: buildResult(
        Array.from({ length: 80 }, (_, idx) => ({ key: `agent:main:chat:${idx + 1}` })),
        {
          count: 80,
          total: 81,
          limit: 80,
          offset: 0,
          hasMore: true,
          nextOffset: 80,
        },
      ),
    });

    const appendLoad = loadChatThreads(state, { mode: "append" });
    await Promise.resolve();

    await loadChatThreads(state, { mode: "reset", search: " filtered " });

    expect(state.chatThreadsQueuedLoad).toEqual({
      search: " filtered ",
      limit: undefined,
      includeGlobal: undefined,
      includeUnknown: undefined,
      mode: "reset",
    });
    expect(request).toHaveBeenCalledTimes(1);

    resolveAppend?.(appendResult);
    await appendLoad;
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      includeSubagents: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      kind: "direct",
      limit: CHAT_THREADS_PAGE_SIZE,
      offset: 0,
      search: "filtered",
    });
    expect(state.chatThreadsQueuedLoad).toBeNull();
    expect(state.chatThreadsResult).toEqual(resetResult);
  });
});
