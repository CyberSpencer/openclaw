import { describe, expect, it } from "vitest";
import "../styles.css";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("control UI skip link", () => {
  it("stays off-screen until focused", async () => {
    const app = mountApp("/skills");
    app.connected = true;
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>(".skip-link");
    expect(link).not.toBeNull();
    if (!link) {
      return;
    }

    const hiddenRect = link.getBoundingClientRect();
    expect(hiddenRect.bottom).toBeLessThan(0);

    link.focus();
    await wait(180);
    expect(document.activeElement).toBe(link);

    const focusedRect = link.getBoundingClientRect();
    expect(focusedRect.top).toBeGreaterThanOrEqual(0);
  });
});
