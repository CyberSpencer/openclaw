import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "./pi-embedded-runner/runs.js";

function createHandle(overrides: Partial<EmbeddedPiQueueHandle> = {}): EmbeddedPiQueueHandle & {
  queueMessage: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  return {
    queueMessage: vi.fn(async () => undefined),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
    ...overrides,
  };
}

describe("queueEmbeddedPiMessage", () => {
  afterEach(() => {
    // Clean up any active runs by clearing with a dummy handle
    // (clearActiveEmbeddedRun only removes if handle matches)
  });

  it("returns false when the session has no active handle", () => {
    expect(queueEmbeddedPiMessage("sess-missing", "redirect")).toBe(false);
  });

  it("returns false when the handle is active but not streaming", () => {
    const handle = createHandle({
      isStreaming: () => false,
    });
    setActiveEmbeddedRun("sess-main-ns", handle, "main");

    expect(queueEmbeddedPiMessage("sess-main-ns", "redirect")).toBe(false);
    expect(handle.queueMessage).not.toHaveBeenCalled();
    clearActiveEmbeddedRun("sess-main-ns", handle, "main");
  });

  it("returns false when compaction is in flight", () => {
    const handle = createHandle({
      isCompacting: () => true,
    });
    setActiveEmbeddedRun("sess-main-c", handle, "main");

    expect(queueEmbeddedPiMessage("sess-main-c", "redirect")).toBe(false);
    expect(handle.queueMessage).not.toHaveBeenCalled();
    clearActiveEmbeddedRun("sess-main-c", handle, "main");
  });

  it("returns true and enqueues the message when streaming", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("sess-main-s", handle, "main");

    expect(queueEmbeddedPiMessage("sess-main-s", "redirect")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledWith("redirect");
    clearActiveEmbeddedRun("sess-main-s", handle, "main");
  });
});
