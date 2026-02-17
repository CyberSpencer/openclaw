import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenClawApp } from "./app.ts";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = OpenClawApp.prototype.connect;

function mountApp(pathname: string): OpenClawApp {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  return app;
}

describe("chat compose state partitioning by session", () => {
  beforeEach(() => {
    OpenClawApp.prototype.connect = () => {
      // no-op
    };
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
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  afterEach(() => {
    OpenClawApp.prototype.connect = originalConnect;
    document.body.innerHTML = "";
    localStorage.clear?.();
  });

  it("preserves draft/queue/attachments when switching sessions", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.sessionKey = "session-a";
    app.chatMessage = "draft-a";
    app.chatQueue = [{ id: "q-a", text: "queued-a", createdAt: 1 }];
    app.chatAttachments = [{ id: "att-a", dataUrl: "data:text/plain,a", mimeType: "text/plain" }];

    app.openChatSession("session-b");

    expect(app.chatMessage).toBe("");
    expect(app.chatQueue).toEqual([]);
    expect(app.chatAttachments).toEqual([]);

    app.chatMessage = "draft-b";
    app.chatQueue = [{ id: "q-b", text: "queued-b", createdAt: 2 }];
    app.chatAttachments = [{ id: "att-b", dataUrl: "data:text/plain,b", mimeType: "text/plain" }];

    app.openChatSession("session-a");

    expect(app.chatMessage).toBe("draft-a");
    expect(app.chatQueue).toEqual([{ id: "q-a", text: "queued-a", createdAt: 1 }]);
    expect(app.chatAttachments).toEqual([
      { id: "att-a", dataUrl: "data:text/plain,a", mimeType: "text/plain" },
    ]);

    app.openChatSession("session-b");

    expect(app.chatMessage).toBe("draft-b");
    expect(app.chatQueue).toEqual([{ id: "q-b", text: "queued-b", createdAt: 2 }]);
    expect(app.chatAttachments).toEqual([
      { id: "att-b", dataUrl: "data:text/plain,b", mimeType: "text/plain" },
    ]);
  });
});
