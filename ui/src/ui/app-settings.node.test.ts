import { describe, expect, it, vi } from "vitest";
import { applySettingsFromUrl, onPopState } from "./app-settings.ts";

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:32555",
      token: "",
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      chatThreadsCollapsedGroups: {},
    },
    sessionKey: "agent:main:main",
    tab: "chat",
    connected: false,
    chatHasAutoScrolled: false,
    logsPollInterval: null,
    debugPollInterval: null,
    nodesPollInterval: null,
    openChatSession: vi.fn(),
  } as unknown as Parameters<typeof applySettingsFromUrl>[0];
}

describe("session routing from URL/popstate", () => {
  it("uses openChatSession during URL session hydration", () => {
    const host = createHost();
    window.history.replaceState({}, "", "/chat?session=agent%3Aops%3Awork");

    applySettingsFromUrl(host);

    expect(host.openChatSession).toHaveBeenCalledWith("agent:ops:work");
  });

  it("uses openChatSession on popstate session changes", () => {
    const host = createHost();
    window.history.replaceState({}, "", "/chat?session=agent%3Aops%3Awork");

    onPopState(host);

    expect(host.openChatSession).toHaveBeenCalledWith("agent:ops:work");
  });
});
