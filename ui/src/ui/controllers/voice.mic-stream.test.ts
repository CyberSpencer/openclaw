import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceState, ensureConversationMicStream } from "./voice.ts";

const originalMediaDevices = navigator.mediaDevices;

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
});

function createFakeStream(label: string): MediaStream {
  const track = {
    readyState: "live",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    id: `stream-${label}`,
    getTracks: () => [track],
  } as unknown as MediaStream;
}

describe("ensureConversationMicStream", () => {
  it("reuses existing live stream across turns", async () => {
    const first = createFakeStream("first");
    const getUserMedia = vi.fn(async () => first);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const state = createVoiceState();

    const streamA = await ensureConversationMicStream(state);
    const streamB = await ensureConversationMicStream(state);

    expect(streamA).toBe(first);
    expect(streamB).toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("reacquires stream when prior stream has ended", async () => {
    const firstTrack = {
      readyState: "ended",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stale = {
      id: "stream-stale",
      getTracks: () => [firstTrack],
    } as unknown as MediaStream;

    const fresh = createFakeStream("fresh");
    const getUserMedia = vi.fn(async () => fresh);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const state = createVoiceState();
    state.mediaStream = stale;

    const stream = await ensureConversationMicStream(state);

    expect(stream).toBe(fresh);
    expect(state.mediaStream).toBe(fresh);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
