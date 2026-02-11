import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceState, playAudioBase64 } from "./voice.ts";

const OriginalAudio = globalThis.Audio;
const OriginalAudioContext = globalThis.AudioContext;
const OriginalAudioWorkletNode = globalThis.AudioWorkletNode;
const OriginalIsSecureContext = window.isSecureContext;

afterEach(() => {
  if (OriginalAudio === undefined) {
    delete (globalThis as { Audio?: typeof Audio }).Audio;
  } else {
    globalThis.Audio = OriginalAudio;
  }
  if (OriginalAudioContext === undefined) {
    delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  } else {
    globalThis.AudioContext = OriginalAudioContext;
  }
  if (OriginalAudioWorkletNode === undefined) {
    delete (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;
  } else {
    globalThis.AudioWorkletNode = OriginalAudioWorkletNode;
  }
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: OriginalIsSecureContext,
  });
});

describe("playAudioBase64", () => {
  it("falls back to HTMLAudio when playback worklet module load fails", async () => {
    const addModule = vi.fn(async () => {
      throw new Error("Unable to load a worklet's module.");
    });
    const audioConstruct = vi.fn();

    class FakeAudioContext {
      state = "running";
      destination = {} as AudioDestinationNode;
      async resume() {}
      async close() {}
      async decodeAudioData(_buffer: ArrayBuffer) {
        return {
          getChannelData: () => new Float32Array([0]),
        } as unknown as AudioBuffer;
      }
    }
    (
      FakeAudioContext as unknown as {
        prototype: { audioWorklet?: { addModule: () => Promise<void> } };
      }
    ).prototype.audioWorklet = { addModule };

    class FakeAudioWorkletNode {
      port = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        start: vi.fn(),
      };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    class FakeAudio {
      currentTime = 0;
      private listeners = new Map<string, Set<EventListener>>();
      constructor(_src: string) {
        audioConstruct();
      }
      addEventListener(type: string, cb: EventListener) {
        const set = this.listeners.get(type) ?? new Set<EventListener>();
        set.add(cb);
        this.listeners.set(type, set);
      }
      removeEventListener(type: string, cb: EventListener) {
        this.listeners.get(type)?.delete(cb);
      }
      async play() {
        setTimeout(() => {
          const set = this.listeners.get("ended");
          if (!set) {
            return;
          }
          for (const listener of set) {
            listener(new Event("ended"));
          }
        }, 0);
      }
      pause() {}
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    globalThis.Audio = FakeAudio as unknown as typeof Audio;
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const state = createVoiceState();
    await expect(playAudioBase64("ZmFrZQ==", state, "wav")).resolves.toBeUndefined();

    expect(addModule).toHaveBeenCalledTimes(1);
    expect(audioConstruct).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe("speaking");
  });
});
