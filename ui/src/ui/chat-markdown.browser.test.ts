import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat markdown rendering", () => {
  it("opens tool output in sidebar from terminal tool entries", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolcall", name: "noop", arguments: {} },
          { type: "toolresult", name: "noop", text: "Hello **world**" },
        ],
        timestamp,
      },
    ];

    await app.updateComplete;

    const toolEntry = app.querySelector<HTMLElement>(".terminal-entry--tool");
    expect(toolEntry).not.toBeNull();

    const viewButton = toolEntry?.querySelector<HTMLButtonElement>(".terminal-entry__open");
    expect(viewButton).not.toBeNull();
    viewButton?.click();

    await app.updateComplete;

    const code = app.querySelector(".sidebar-markdown code");
    expect(code?.textContent).toContain("Hello **world**");
  });
});
