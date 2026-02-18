import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawApp } from "./app.ts";
import "../styles.css";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = OpenClawApp.prototype.connect;
const OriginalAudioContext = globalThis.AudioContext;
const OriginalAudioWorkletNode = globalThis.AudioWorkletNode;
const OriginalMediaRecorder = globalThis.MediaRecorder;
const OriginalMediaDevices = navigator.mediaDevices;
const OriginalIsSecureContext = window.isSecureContext;

type FakeTrack = { stop: ReturnType<typeof vi.fn> };
type FakeStream = MediaStream & { __track: FakeTrack };

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createFakeStream(): FakeStream {
  const track: FakeTrack = { stop: vi.fn() };
  return {
    getTracks: () => [track as unknown as MediaStreamTrack],
    __track: track,
  } as unknown as FakeStream;
}

function mountApp(pathname: string): OpenClawApp {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  return app;
}

function setSparkAvailable(app: OpenClawApp) {
  app.connected = true;
  app.sparkStatus = { enabled: true, voiceAvailable: true };
}

beforeEach(() => {
  OpenClawApp.prototype.connect = () => {
    // no-op: avoid real gateway WS connections in browser tests
  };
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  OpenClawApp.prototype.connect = originalConnect;
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
  if (OriginalMediaRecorder === undefined) {
    delete (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  } else {
    globalThis.MediaRecorder = OriginalMediaRecorder;
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: OriginalMediaDevices,
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: OriginalIsSecureContext,
  });
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("spark mic worklet fallback", () => {
  it("falls back to MediaRecorder when worklet module load fails", async () => {
    const addModule = vi.fn(async () => {
      throw new DOMException("Unable to load a worklet's module.");
    });
    const getUserMedia = vi.fn(async () => createFakeStream());
    const mediaRecorderConstruct = vi.fn();

    class FakeAudioContext {
      state = "running";
      destination = {} as AudioDestinationNode;
      audioWorklet = { addModule };
      async resume() {}
      async close() {}
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
      }
      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as GainNode;
      }
    }

    class FakeAudioWorkletNode {
      port = { addEventListener: vi.fn(), removeEventListener: vi.fn(), start: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        mediaRecorderConstruct();
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const app = mountApp("/chat");
    await app.updateComplete;
    setSparkAvailable(app);

    await app.handleSparkMicClick();

    expect(addModule.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mediaRecorderConstruct).toHaveBeenCalledTimes(1);
    expect(app.sparkMicRecording).toBe(true);
    expect(app.lastError).toBeNull();

    await app.handleSparkMicClick();
    await Promise.resolve();
    expect(app.sparkMicRecording).toBe(false);
  });

  it("disables worklet retries for the session after first load failure", async () => {
    const addModule = vi.fn(async () => {
      throw new DOMException("Unable to load a worklet's module.");
    });
    const getUserMedia = vi.fn(async () => createFakeStream());
    const mediaRecorderConstruct = vi.fn();

    class FakeAudioContext {
      state = "running";
      destination = {} as AudioDestinationNode;
      audioWorklet = { addModule };
      async resume() {}
      async close() {}
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
      }
      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as GainNode;
      }
    }

    class FakeAudioWorkletNode {
      port = { addEventListener: vi.fn(), removeEventListener: vi.fn(), start: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        mediaRecorderConstruct();
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const app = mountApp("/chat");
    await app.updateComplete;
    setSparkAvailable(app);

    await app.handleSparkMicClick();
    const addModuleCallsAfterFirstStart = addModule.mock.calls.length;
    await app.handleSparkMicClick();
    await Promise.resolve();

    await app.handleSparkMicClick();

    expect(addModuleCallsAfterFirstStart).toBeLessThanOrEqual(1);
    expect(addModule.mock.calls.length).toBe(addModuleCallsAfterFirstStart);
    expect(mediaRecorderConstruct).toHaveBeenCalledTimes(2);
    expect(app.sparkMicRecording).toBe(true);

    await app.handleSparkMicClick();
    await Promise.resolve();
    expect(app.sparkMicRecording).toBe(false);
  });

  it("surfaces recording failure when worklet and MediaRecorder both fail", async () => {
    const addModule = vi.fn(async () => {
      throw new DOMException("Unable to load a worklet's module.");
    });
    const getUserMedia = vi.fn(async () => createFakeStream());

    class FakeAudioContext {
      state = "running";
      destination = {} as AudioDestinationNode;
      audioWorklet = { addModule };
      async resume() {}
      async close() {}
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
      }
      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        } as unknown as GainNode;
      }
    }

    class FakeAudioWorkletNode {
      port = { addEventListener: vi.fn(), removeEventListener: vi.fn(), start: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    delete (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const app = mountApp("/chat");
    await app.updateComplete;
    setSparkAvailable(app);

    await app.handleSparkMicClick();

    expect(addModule.mock.calls.length).toBeLessThanOrEqual(1);
    expect(app.sparkMicRecording).toBe(false);
    expect(app.lastError).toContain("Recording failed:");
  });
});

describe("spark mic chunked interim updates", () => {
  it("updates chat message from chunked MediaRecorder events before stop", async () => {
    const getUserMedia = vi.fn(async () => createFakeStream());

    class FakeMediaRecorder {
      static lastInstance: FakeMediaRecorder | null = null;
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      startTimeslice: number | undefined;
      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        FakeMediaRecorder.lastInstance = this;
      }
      start(timeslice?: number) {
        this.startTimeslice = timeslice;
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
      emitChunk(text: string) {
        const blob = new Blob([text], { type: "audio/webm" });
        this.ondataavailable?.({ data: blob } as BlobEvent);
      }
    }

    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    const app = mountApp("/chat");
    await app.updateComplete;
    setSparkAvailable(app);

    let sttCall = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "spark.status") {
        return { enabled: true, voiceAvailable: true };
      }
      if (method === "spark.voice.stt") {
        sttCall += 1;
        if (sttCall === 1) {
          return { text: "hello there" };
        }
        return { text: "there friend" };
      }
      return {};
    });
    app.client = { request } as unknown as typeof app.client;

    await app.handleSparkMicClick();

    const rec = FakeMediaRecorder.lastInstance;
    expect(rec).toBeTruthy();
    expect(rec?.startTimeslice).toBe(4000);

    rec?.emitChunk("chunk-one");
    await flushAsync();
    expect(app.chatMessage).toBe("hello there");

    rec?.emitChunk("chunk-two");
    await flushAsync();
    expect(app.chatMessage).toBe("hello there friend");

    await app.handleSparkMicClick();
    await flushAsync();
    expect(app.sparkMicRecording).toBe(false);
  });

  it("processes queued chunks without overlapping STT requests", async () => {
    const getUserMedia = vi.fn(async () => createFakeStream());

    let resolveFirst: (() => void) | null = null;

    class FakeMediaRecorder {
      static lastInstance: FakeMediaRecorder | null = null;
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, _opts?: MediaRecorderOptions) {
        FakeMediaRecorder.lastInstance = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
      emitChunk(text: string) {
        const blob = new Blob([text], { type: "audio/webm" });
        this.ondataavailable?.({ data: blob } as BlobEvent);
      }
    }

    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    let sttCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "spark.status") {
        return { enabled: true, voiceAvailable: true };
      }
      if (method === "spark.voice.stt") {
        sttCalls += 1;
        if (sttCalls === 1) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
          return { text: "first" };
        }
        return { text: "second" };
      }
      return {};
    });

    const app = mountApp("/chat");
    await app.updateComplete;
    setSparkAvailable(app);
    app.client = { request } as unknown as typeof app.client;

    await app.handleSparkMicClick();
    const rec = FakeMediaRecorder.lastInstance;
    expect(rec).toBeTruthy();

    rec?.emitChunk("chunk-a");
    rec?.emitChunk("chunk-b");
    await flushAsync();

    expect(sttCalls).toBe(1);

    resolveFirst?.();
    await flushAsync(8);

    expect(sttCalls).toBe(2);
    expect(app.chatMessage).toContain("first");

    await app.handleSparkMicClick();
    await flushAsync();
    expect(app.sparkMicRecording).toBe(false);
  });
});

describe("spark status polling resilience", () => {
  it("does not stop an active spark conversation on a single status poll failure", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    setSparkAvailable(app);
    await app.updateComplete;
    app.voiceState.mode = "spark";
    app.voiceState.conversationActive = true;
    app.voiceState.sparkVoiceAvailable = true;

    app.client = {
      request: vi.fn(async () => {
        throw new Error("spark.status timeout");
      }),
    } as unknown as typeof app.client;

    await app.refreshSparkStatus();

    expect(app.voiceState.conversationActive).toBe(true);
    expect(app.voiceState.sparkVoiceAvailable).toBe(true);
    expect(app.sparkStatus?.voiceAvailable).toBe(true);
    expect(app.voiceState.error ?? "").not.toContain("Conversation stopped");
  });

  it("keeps spark unavailable after reconnect until a successful status poll", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    setSparkAvailable(app);
    await app.updateComplete;
    expect(app.sparkStatus?.voiceAvailable).toBe(true);

    app.connected = false;
    await app.updateComplete;

    expect(app.sparkStatus).toBeNull();
    expect(app.voiceState.sparkVoiceAvailable).toBe(false);

    app.client = {
      request: vi.fn(async () => {
        throw new Error("spark.status timeout");
      }),
    } as unknown as typeof app.client;

    app.connected = true;
    await app.updateComplete;
    await app.refreshSparkStatus();

    expect(app.sparkStatus).toBeNull();
    expect(app.voiceState.sparkVoiceAvailable).toBe(false);
  });

  it("stops active conversation after repeated spark.status poll failures", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    setSparkAvailable(app);
    await app.updateComplete;
    app.voiceState.mode = "spark";
    app.voiceState.conversationActive = true;
    app.voiceState.sparkVoiceAvailable = true;

    app.client = {
      request: vi.fn(async () => {
        throw new Error("spark.status timeout");
      }),
    } as unknown as typeof app.client;

    await app.refreshSparkStatus();
    await app.refreshSparkStatus();
    await app.refreshSparkStatus();

    expect(app.voiceState.conversationActive).toBe(false);
    expect(app.sparkStatus).toBeNull();
    expect(app.voiceState.error).toBe(
      "Spark status polling failed repeatedly. Conversation stopped.",
    );
  });

  it("stops active conversation immediately when a successful poll reports voice unavailable", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    setSparkAvailable(app);
    await app.updateComplete;
    app.voiceState.mode = "spark";
    app.voiceState.conversationActive = true;
    app.voiceState.sparkVoiceAvailable = true;

    app.client = {
      request: vi.fn(async () => ({ enabled: true, voiceAvailable: false })),
    } as unknown as typeof app.client;

    await app.refreshSparkStatus();

    expect(app.voiceState.conversationActive).toBe(false);
    expect(app.voiceState.error).toBe("Spark voice became unavailable. Conversation stopped.");
  });
});
