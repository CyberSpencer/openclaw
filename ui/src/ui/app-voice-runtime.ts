import type { UiSettings } from "./storage.ts";
import { chunkTextForTts, type SparkVoiceTtsResult } from "./app-runtime-utils.ts";
import { pcmFramesToWavBlob } from "./controllers/audio-capture.ts";
import { normalizeTextForTts } from "./text-normalization.ts";
import { buildWorkletModuleUrl } from "./worklets.ts";

const WORKLET_VERSION = "20260210-v1";

type GatewayClient = {
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

export type VoiceRuntimeHost = {
  client: GatewayClient | null;
  connected: boolean;
  chatMessage: string;
  lastError: string | null;
  basePath: string;
  settings: UiSettings;

  sparkMicRecording: boolean;
  sparkMicMediaRecorder: MediaRecorder | null;
  sparkMicStream: MediaStream | null;
  sparkMicAudioContext: AudioContext | null;
  sparkMicCaptureWorklet: AudioWorkletNode | null;
  sparkMicPcmFrames: Int16Array[];
  sparkMicSampleRate: number;
  sparkMicUsingWorklet: boolean;
  sparkMicChunks: Blob[];
  sparkMicRecordingTimer: ReturnType<typeof setTimeout> | null;
  sparkMicWorkletDisabledForSession: boolean;

  ttsSpeaking: boolean;
  ttsProgress: string | null;
  ttsSpeakingMessageKey: string | null;
  ttsAbortController: AbortController | null;
  ttsCurrentAudio: HTMLAudioElement | null;
  ttsPlaybackContext: AudioContext | null;
  ttsPlaybackWorklet: AudioWorkletNode | null;

  isSparkVoiceAvailable: () => boolean;
  supportsAudioWorklet: () => boolean;
  blobToBase64: (blob: Blob) => Promise<string>;
  base64ToArrayBuffer: (base64: string) => ArrayBuffer;
  ensureTtsPlaybackWorklet: () => Promise<boolean>;
  requestUpdate: () => void;
};

export async function handleSparkMicAudio(
  host: VoiceRuntimeHost,
  params: { audioBase64: string; format: string; sampleRate?: number },
) {
  if (!host.client || !host.connected) {
    return;
  }

  try {
    const result = await host.client.request("spark.voice.stt", {
      audio_base64: params.audioBase64,
      format: params.format,
      sample_rate: params.sampleRate,
    });
    const text = (result as Record<string, unknown>)?.text;
    if (typeof text === "string" && text.trim()) {
      const existing = host.chatMessage?.trim() ?? "";
      host.chatMessage = existing ? `${existing} ${text.trim()}` : text.trim();
    } else {
      const msg = "No speech detected. Try again.";
      host.lastError = msg;
      host.requestUpdate();
      setTimeout(() => {
        if (host.lastError === msg) {
          host.lastError = null;
          host.requestUpdate();
        }
      }, 3000);
    }
  } catch (err) {
    console.error("[spark-mic] STT request failed:", err);
    host.lastError = `Voice input failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function startSparkMicRecording(host: VoiceRuntimeHost) {
  if (!host.isSparkVoiceAvailable()) {
    host.lastError = "Spark voice unavailable. Recording blocked.";
    host.sparkMicRecording = false;
    host.requestUpdate();
    return;
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    const shouldTryWorklet = host.supportsAudioWorklet() && !host.sparkMicWorkletDisabledForSession;
    if (shouldTryWorklet) {
      const started = await tryStartSparkMicWorklet(host, stream);
      if (started) {
        host.requestUpdate();
        return;
      }
    }

    startSparkMicMediaRecorder(host, stream);
    host.requestUpdate();
  } catch (err) {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    console.error("[spark-mic] Failed to start recording:", err);
    host.sparkMicRecording = false;
    host.lastError =
      err instanceof Error && err.name === "NotAllowedError"
        ? "Microphone access denied. Allow mic in browser or system settings."
        : `Recording failed: ${err instanceof Error ? err.message : String(err)}`;
    host.requestUpdate();
  }
}

export async function tryStartSparkMicWorklet(
  host: VoiceRuntimeHost,
  stream: MediaStream,
): Promise<boolean> {
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let captureWorklet: AudioWorkletNode | null = null;
  let zeroGain: GainNode | null = null;
  try {
    audioContext = new AudioContext({ sampleRate: host.sparkMicSampleRate });
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }

    const workletUrl = buildWorkletModuleUrl(
      "capture-processor.js",
      WORKLET_VERSION,
      host.basePath,
    );
    await audioContext.audioWorklet.addModule(workletUrl);

    source = audioContext.createMediaStreamSource(stream);
    captureWorklet = new AudioWorkletNode(audioContext, "capture-processor", {
      processorOptions: {
        targetSampleRate: host.sparkMicSampleRate,
        frameSize: 480,
      },
    });

    zeroGain = audioContext.createGain();
    zeroGain.gain.value = 0;
    captureWorklet.connect(zeroGain);
    zeroGain.connect(audioContext.destination);

    host.sparkMicPcmFrames = [];
    captureWorklet.port.addEventListener("message", (event) => {
      if (event.data?.type === "audio" && event.data?.pcm16) {
        host.sparkMicPcmFrames.push(event.data.pcm16 as Int16Array);
      }
    });
    captureWorklet.port.start();
    source.connect(captureWorklet);

    host.sparkMicStream = stream;
    host.sparkMicAudioContext = audioContext;
    host.sparkMicCaptureWorklet = captureWorklet;
    host.sparkMicUsingWorklet = true;
    host.sparkMicRecording = true;
    host.sparkMicRecordingTimer = setTimeout(() => {
      void stopSparkMicRecording(host);
    }, 30_000);

    return true;
  } catch (err) {
    console.warn("[spark-mic] Worklet capture unavailable; falling back to MediaRecorder", err);
    host.sparkMicWorkletDisabledForSession = true;
    host.sparkMicUsingWorklet = false;
    host.sparkMicStream = null;
    host.sparkMicAudioContext = null;
    host.sparkMicCaptureWorklet = null;
    host.sparkMicPcmFrames = [];
    try {
      source?.disconnect();
    } catch {
      // ignore
    }
    try {
      captureWorklet?.disconnect();
    } catch {
      // ignore
    }
    try {
      zeroGain?.disconnect();
    } catch {
      // ignore
    }
    try {
      await audioContext?.close();
    } catch {
      // ignore
    }
    return false;
  }
}

export function startSparkMicMediaRecorder(host: VoiceRuntimeHost, stream: MediaStream): void {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder not supported in this browser.");
  }

  host.sparkMicChunks = [];
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  const recorder = new MediaRecorder(stream, { mimeType });
  host.sparkMicMediaRecorder = recorder;
  host.sparkMicUsingWorklet = false;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      host.sparkMicChunks.push(event.data);
    }
  };

  recorder.onstop = async () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (host.sparkMicRecordingTimer) {
      clearTimeout(host.sparkMicRecordingTimer);
      host.sparkMicRecordingTimer = null;
    }

    try {
      if (host.sparkMicChunks.length > 0) {
        const blob = new Blob(host.sparkMicChunks, { type: mimeType });
        host.sparkMicChunks = [];
        const audioBase64 = await host.blobToBase64(blob);
        await handleSparkMicAudio(host, { audioBase64, format: "webm" });
      }
    } catch (err) {
      console.error("[spark-mic] Failed while processing MediaRecorder audio:", err);
      host.lastError = `Recording failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      host.sparkMicRecording = false;
      host.requestUpdate();
    }
  };

  recorder.start();
  host.sparkMicRecording = true;
  host.sparkMicRecordingTimer = setTimeout(() => {
    void stopSparkMicRecording(host);
  }, 30_000);
}

export async function stopSparkMicRecording(host: VoiceRuntimeHost) {
  if (host.sparkMicRecordingTimer) {
    clearTimeout(host.sparkMicRecordingTimer);
    host.sparkMicRecordingTimer = null;
  }

  if (host.sparkMicUsingWorklet) {
    await finishSparkMicWorkletRecording(host);
    return;
  }

  if (host.sparkMicMediaRecorder && host.sparkMicMediaRecorder.state !== "inactive") {
    host.sparkMicMediaRecorder.stop();
  }
  host.sparkMicMediaRecorder = null;
  // sparkMicRecording will be set to false in the onstop handler
}

export async function finishSparkMicWorkletRecording(host: VoiceRuntimeHost) {
  if (!host.sparkMicUsingWorklet) {
    return;
  }

  // Snapshot frames and reset state early to avoid re-entrancy.
  const frames = host.sparkMicPcmFrames;
  host.sparkMicPcmFrames = [];
  host.sparkMicUsingWorklet = false;

  const stream = host.sparkMicStream;
  const audioContext = host.sparkMicAudioContext;
  const capture = host.sparkMicCaptureWorklet;

  host.sparkMicStream = null;
  host.sparkMicAudioContext = null;
  host.sparkMicCaptureWorklet = null;

  // Stop inputs
  try {
    capture?.disconnect();
  } catch {
    // ignore
  }
  try {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  } catch {
    // ignore
  }
  try {
    await audioContext?.close();
  } catch {
    // ignore
  }

  if (!frames.length) {
    host.sparkMicRecording = false;
    host.requestUpdate();
    return;
  }

  const { blob } = pcmFramesToWavBlob(frames, host.sparkMicSampleRate);
  if (!blob) {
    host.sparkMicRecording = false;
    host.requestUpdate();
    return;
  }

  const audioBase64 = await host.blobToBase64(blob);
  await handleSparkMicAudio(host, {
    audioBase64,
    format: "wav",
    sampleRate: host.sparkMicSampleRate,
  });

  host.sparkMicRecording = false;
  host.requestUpdate();
}

/** Returns optional TTS params (voice, instruct, language) from persisted settings. Only includes non-empty values. */
export function getTtsRequestParams(host: VoiceRuntimeHost): {
  voice?: string;
  instruct?: string;
  language?: string;
} {
  const out: { voice?: string; instruct?: string; language?: string } = {};
  const v = host.settings.ttsVoice?.trim();
  const i = host.settings.ttsInstruct?.trim();
  const l = host.settings.ttsLanguage?.trim();
  if (v) {
    out.voice = v;
  }
  if (i) {
    out.instruct = i;
  }
  if (l) {
    out.language = l;
  }
  return out;
}

export function handleStopSpeaking(host: VoiceRuntimeHost) {
  if (host.ttsAbortController) {
    host.ttsAbortController.abort();
  }
  if (host.ttsPlaybackWorklet) {
    host.ttsPlaybackWorklet.port.postMessage({ type: "clear" });
  }
  if (host.ttsCurrentAudio) {
    host.ttsCurrentAudio.pause();
    host.ttsCurrentAudio.currentTime = 0;
    host.ttsCurrentAudio = null;
  }
  host.ttsSpeaking = false;
  host.ttsProgress = null;
  host.ttsSpeakingMessageKey = null;
  host.ttsAbortController = null;
  host.requestUpdate();
}

export async function handleSpeakText(host: VoiceRuntimeHost, text: string, messageKey?: string) {
  if (!text.trim() || !host.client || !host.connected) {
    return;
  }
  host.lastError = null;
  const trimmed = normalizeTextForTts(text.trim());
  const chunks = chunkTextForTts(trimmed);
  if (chunks.length === 0) {
    return;
  }

  host.ttsAbortController = new AbortController();
  host.ttsSpeaking = true;
  host.ttsProgress = `Speaking 1/${chunks.length}...`;
  host.ttsSpeakingMessageKey = messageKey ?? null;
  host.requestUpdate();

  console.log("[spark-tts] request", {
    textLength: trimmed.length,
    chunkCount: chunks.length,
    textPreview: trimmed.slice(0, 50),
  });

  const useWorklet = await host.ensureTtsPlaybackWorklet();
  console.log("[spark-tts] playback path:", useWorklet ? "worklet" : "audio-element");

  if (useWorklet && host.ttsPlaybackWorklet && host.ttsPlaybackContext) {
    const worklet = host.ttsPlaybackWorklet;
    const ctx = host.ttsPlaybackContext;

    worklet.port.postMessage({ type: "clear" });

    const playbackCompletePromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === "playback_complete") {
          worklet.port.removeEventListener("message", handler);
          resolve();
        }
      };
      worklet.port.addEventListener("message", handler);
      host.ttsAbortController?.signal.addEventListener(
        "abort",
        () => {
          worklet.port.removeEventListener("message", handler);
          resolve();
        },
        { once: true },
      );
    });

    const fetchChunkForWorklet = async (idx: number): Promise<Float32Array> => {
      const result = await host.client!.request<SparkVoiceTtsResult>("spark.voice.tts", {
        text: chunks[idx],
        ...getTtsRequestParams(host),
      });
      const b64 = result?.audio_base64;
      if (typeof b64 !== "string" || !b64) {
        throw new Error(`Chunk ${idx + 1}: no audio`);
      }
      const buffer = host.base64ToArrayBuffer(b64);
      const arrayBuffer = await ctx.decodeAudioData(buffer);
      const chan = arrayBuffer.getChannelData(0);
      return new Float32Array(chan);
    };

    try {
      let nextPromise = fetchChunkForWorklet(0);

      for (let i = 0; i < chunks.length; i++) {
        if (host.ttsAbortController?.signal.aborted) {
          break;
        }

        const float32 = await nextPromise;
        if (i + 1 < chunks.length) {
          nextPromise = fetchChunkForWorklet(i + 1);
        }

        if (host.ttsAbortController?.signal.aborted) {
          break;
        }

        host.ttsProgress = `Speaking ${i + 1}/${chunks.length}...`;
        host.requestUpdate();

        worklet.port.postMessage({ type: "audio", data: float32, seq: i + 1 });
      }

      if (!host.ttsAbortController?.signal.aborted) {
        worklet.port.postMessage({ type: "server_audio_complete" });
        await playbackCompletePromise;
      }
      console.log("[spark-tts] worklet playback ok");
    } catch (err) {
      if (host.ttsAbortController?.signal.aborted) {
        console.log("[spark-tts] stopped by user");
      } else {
        console.warn("[spark-tts] worklet path failed, falling back to audio element:", err);
        try {
          await playTtsChunksWithAudioElement(host, chunks);
        } catch (fallbackErr) {
          console.error("[spark-tts] audio element fallback failed:", fallbackErr);
          host.lastError = `Speech failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
        }
      }
    } finally {
      host.ttsSpeaking = false;
      host.ttsProgress = null;
      host.ttsSpeakingMessageKey = null;
      host.ttsAbortController = null;
      host.ttsCurrentAudio = null;
      host.requestUpdate();
    }
    return;
  }

  try {
    await playTtsChunksWithAudioElement(host, chunks);
  } catch (err) {
    if (host.ttsAbortController?.signal.aborted) {
      console.log("[spark-tts] stopped by user");
    } else {
      console.error("[spark-tts] Failed:", err);
      host.lastError = `Speech failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } finally {
    host.ttsSpeaking = false;
    host.ttsProgress = null;
    host.ttsSpeakingMessageKey = null;
    host.ttsAbortController = null;
    host.ttsCurrentAudio = null;
    host.requestUpdate();
  }
}

export async function playTtsChunksWithAudioElement(
  host: VoiceRuntimeHost,
  chunks: string[],
): Promise<void> {
  if (!host.client) {
    return;
  }

  const fetchChunkAudio = async (idx: number): Promise<HTMLAudioElement> => {
    const result = await host.client!.request<SparkVoiceTtsResult>("spark.voice.tts", {
      text: chunks[idx],
      ...getTtsRequestParams(host),
    });
    const b64 = result?.audio_base64;
    if (typeof b64 !== "string" || !b64) {
      throw new Error(`Chunk ${idx + 1}: no audio`);
    }
    const fmt = (result?.format as string) ?? "webm";
    const mime = fmt === "webm" ? "audio/webm" : `audio/${fmt}`;
    return new Audio(`data:${mime};base64,${b64}`);
  };

  const playAudio = (audio: HTMLAudioElement): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = () => {
        cleanup();
        reject(new Error("Audio playback failed"));
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onCanPlay = () => {
        audio.removeEventListener("canplaythrough", onCanPlay);
        audio.play().catch(onError);
      };
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        audio.removeEventListener("canplaythrough", onCanPlay);
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      if (audio.readyState >= 2) {
        onCanPlay();
      } else {
        audio.addEventListener("canplaythrough", onCanPlay);
      }
    });

  let nextPromise = fetchChunkAudio(0);

  for (let i = 0; i < chunks.length; i++) {
    if (host.ttsAbortController?.signal.aborted) {
      break;
    }

    const audio = await nextPromise;
    if (i + 1 < chunks.length) {
      nextPromise = fetchChunkAudio(i + 1);
    }

    if (host.ttsAbortController?.signal.aborted) {
      break;
    }

    host.ttsProgress = `Speaking ${i + 1}/${chunks.length}...`;
    host.ttsCurrentAudio = audio;
    host.requestUpdate();

    await playAudio(audio);

    host.ttsCurrentAudio = null;
    if (host.ttsAbortController?.signal.aborted) {
      break;
    }
  }
  console.log("[spark-tts] play() ok");
}
