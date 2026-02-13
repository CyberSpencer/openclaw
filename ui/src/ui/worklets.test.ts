import { afterEach, describe, expect, it } from "vitest";
import { buildWorkletModuleUrl, supportsAudioWorkletRuntime } from "./worklets.ts";

const ORIGINAL_AUDIO_CONTEXT = globalThis.AudioContext;
const ORIGINAL_AUDIO_WORKLET_NODE = globalThis.AudioWorkletNode;
const ORIGINAL_IS_SECURE_CONTEXT = window.isSecureContext;

afterEach(() => {
  window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
  if (ORIGINAL_AUDIO_CONTEXT === undefined) {
    delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  } else {
    globalThis.AudioContext = ORIGINAL_AUDIO_CONTEXT;
  }
  if (ORIGINAL_AUDIO_WORKLET_NODE === undefined) {
    delete (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;
  } else {
    globalThis.AudioWorkletNode = ORIGINAL_AUDIO_WORKLET_NODE;
  }
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: ORIGINAL_IS_SECURE_CONTEXT,
  });
});

describe("buildWorkletModuleUrl", () => {
  it("builds root path URLs when base path is empty", () => {
    expect(buildWorkletModuleUrl("capture-processor.js", "abc")).toBe(
      "/worklets/capture-processor.js?v=abc",
    );
  });

  it("builds URLs under a configured base path", () => {
    expect(buildWorkletModuleUrl("capture-processor.js", "abc", "/openclaw")).toBe(
      "/openclaw/worklets/capture-processor.js?v=abc",
    );
  });

  it("normalizes trailing slash on base path", () => {
    expect(buildWorkletModuleUrl("capture-processor.js", "abc", "/openclaw/")).toBe(
      "/openclaw/worklets/capture-processor.js?v=abc",
    );
  });

  it("prefers explicit base path over injected base path", () => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = "/from-window";
    expect(buildWorkletModuleUrl("playback-processor.js", "abc", "/explicit")).toBe(
      "/explicit/worklets/playback-processor.js?v=abc",
    );
  });
});

describe("supportsAudioWorkletRuntime", () => {
  it("returns false outside secure context", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    class FakeAudioContext {}
    class FakeAudioWorkletNode {}
    (FakeAudioContext as unknown as { prototype: Record<string, unknown> }).prototype.audioWorklet =
      {};
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    expect(supportsAudioWorkletRuntime()).toBe(false);
  });

  it("returns true when secure context and APIs are available", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    class FakeAudioContext {}
    class FakeAudioWorkletNode {}
    (FakeAudioContext as unknown as { prototype: Record<string, unknown> }).prototype.audioWorklet =
      {};
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    expect(supportsAudioWorkletRuntime()).toBe(true);
  });

  it("returns false when audio worklet API is missing", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    class FakeAudioContext {}
    class FakeAudioWorkletNode {}
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    expect(supportsAudioWorkletRuntime()).toBe(false);
  });
});
