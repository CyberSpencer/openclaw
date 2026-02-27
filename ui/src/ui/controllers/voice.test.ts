import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceState,
  playAudioBase64,
  recordVoiceShortTurnSloSample,
  stopConversation,
} from "./voice.ts";

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

  it("aborts an active turn when conversation is stopped", () => {
    const state = createVoiceState();
    state.conversationActive = true;
    const controller = new AbortController();
    state.turnAbortController = controller;

    stopConversation(state);

    expect(controller.signal.aborted).toBe(true);
    expect(state.turnAbortController).toBeNull();
    expect(state.conversationActive).toBe(false);
    expect(state.phase).toBe("idle");
  });
});

describe("voice short-turn SLO report", () => {
  it("tracks p50/p95 latency metrics for short turns", () => {
    const state = createVoiceState();

    state.firstStatusTextAtMs = 1_100;
    state.firstAudibleAtMs = 1_200;
    state.firstSemanticTextAtMs = 1_700;
    state.semanticSpokenStartAtMs = 1_900;
    recordVoiceShortTurnSloSample(state, {
      turnId: "turn-1",
      eosAtMs: 1_000,
      speechDurationMs: 2_100,
      outputText: "short answer",
    });

    state.firstStatusTextAtMs = 2_300;
    state.firstAudibleAtMs = 2_450;
    state.firstSemanticTextAtMs = 2_900;
    state.semanticSpokenStartAtMs = 3_050;
    recordVoiceShortTurnSloSample(state, {
      turnId: "turn-2",
      eosAtMs: 2_000,
      speechDurationMs: 3_000,
      outputText: "another short answer",
    });

    // Excluded from short-turn buckets (speech > 6s).
    state.firstStatusTextAtMs = 3_300;
    state.firstAudibleAtMs = 3_450;
    state.firstSemanticTextAtMs = 3_900;
    state.semanticSpokenStartAtMs = 4_050;
    recordVoiceShortTurnSloSample(state, {
      turnId: "turn-3",
      eosAtMs: 3_000,
      speechDurationMs: 6_500,
      outputText: "still collected in total turns",
    });

    expect(state.shortTurnSloReport).toMatchObject({
      totalTurnCount: 3,
      shortTurnCount: 2,
      metrics: {
        eosToFirstAssistantStatusText: { count: 2, p50Ms: 100, p95Ms: 300 },
        eosToFirstAudibleByte: { count: 2, p50Ms: 200, p95Ms: 450 },
        eosToFirstSemanticAssistantText: { count: 2, p50Ms: 700, p95Ms: 900 },
        eosToSemanticSpokenAnswerStart: { count: 2, p50Ms: 900, p95Ms: 1050 },
      },
    });
  });
});
