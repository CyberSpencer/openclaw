import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  queueEmbeddedPiMessageWithStatus,
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

describe("queueEmbeddedPiMessageWithStatus", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
  });

  it("returns no_active_run when the session has no active handle", () => {
    expect(queueEmbeddedPiMessageWithStatus("sess-missing", "redirect")).toBe("no_active_run");
  });

  it("returns not_streaming when the handle is active but not streaming", () => {
    const handle = createHandle({
      isStreaming: () => false,
    });
    setActiveEmbeddedRun("sess-main", handle, "main");

    expect(queueEmbeddedPiMessageWithStatus("sess-main", "redirect")).toBe("not_streaming");
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it("returns compacting when compaction is in flight", () => {
    const handle = createHandle({
      isCompacting: () => true,
    });
    setActiveEmbeddedRun("sess-main", handle, "main");

    expect(queueEmbeddedPiMessageWithStatus("sess-main", "redirect")).toBe("compacting");
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it("returns steered and enqueues the message when streaming", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("sess-main", handle, "main");

    expect(queueEmbeddedPiMessageWithStatus("sess-main", "redirect")).toBe("steered");
    expect(handle.queueMessage).toHaveBeenCalledWith("redirect");
  });
});
