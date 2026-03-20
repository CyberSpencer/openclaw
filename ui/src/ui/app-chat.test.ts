import { describe, expect, it, vi } from "vitest";

vi.mock("./controllers/chat.ts", () => ({
  abortChatRun: vi.fn(),
  loadChatHistory: vi.fn(),
  pauseChatRun: vi.fn(),
  rerouteChatRun: vi.fn(),
  resumeChatRun: vi.fn(),
  sendChatMessage: vi.fn(),
  steerChatMessage: vi.fn(),
}));

import { handleSendChat } from "./app-chat.ts";
import { sendChatMessage, steerChatMessage } from "./controllers/chat.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";

function createHost(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    chatMessage: "redirect",
    chatAttachments: [] as ChatAttachment[],
    chatQueue: [] as ChatQueueItem[],
    chatRunId: null as string | null,
    chatModelLoading: false,
    chatStream: null as string | null,
    compactionStatus: null as { active: boolean } | null,
    chatPaused: false,
    chatSending: false,
    lastError: null as string | null,
    sessionKey: "agent:main:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    chatThreadsLoading: false,
    chatThreadsLoadingMore: false,
    chatThreadsResult: null,
    chatThreadsError: null,
    chatThreadsQuery: "",
    chatThreadsShowSubagents: false,
    resetToolStream: vi.fn(),
    updateComplete: Promise.resolve(),
    querySelector: vi.fn(() => null),
    style: {} as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null,
    ...overrides,
  };
}

describe("handleSendChat", () => {
  it("queues messages when a run is active but not steerable", async () => {
    const host = createHost({
      chatRunId: "run-1",
      chatModelLoading: true,
      chatStream: null,
      chatMessage: "please continue",
    });

    await handleSendChat(host as never);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("please continue");
    expect(vi.mocked(steerChatMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(sendChatMessage)).not.toHaveBeenCalled();
  });

  it("steers text-only messages when the active run is steerable", async () => {
    vi.mocked(steerChatMessage).mockResolvedValueOnce({
      ok: true,
      status: "steered",
    });
    const host = createHost({
      chatRunId: "run-1",
      chatModelLoading: false,
      chatStream: "partial reply",
      chatMessage: "go left",
    });

    await handleSendChat(host as never);

    expect(vi.mocked(steerChatMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChatMessage)).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([]);
  });
});
