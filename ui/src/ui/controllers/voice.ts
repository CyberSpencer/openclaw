/**
 * Voice mode controller for the web UI.
 *
 * Implements a natural conversational voice interface with Voice Activity Detection (VAD).
 * Click once to start a conversation, speak naturally, and click again to end.
 * VAD automatically detects when you stop speaking to trigger processing.
 */

import type { GatewayBrowserClient } from "../gateway";

// VAD Configuration
const VAD_SILENCE_THRESHOLD = 15;      // Audio level below this = silence (0-255)
const VAD_SPEECH_THRESHOLD = 25;       // Audio level above this = speech detected
const VAD_SILENCE_DURATION_MS = 750;   // How long silence before triggering processing (0.75s)
const VAD_MIN_SPEECH_MS = 300;         // Minimum speech duration to be valid

export type ConversationPhase = "idle" | "listening" | "processing" | "speaking";

export type VoiceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enabled: boolean;
  mode: "option2a" | "personaplex" | "hybrid";
  sessionKey: string | null;
  driveOpenClaw: boolean;
  
  // Conversation state
  conversationActive: boolean;
  phase: ConversationPhase;
  
  // VAD state
  speechDetected: boolean;
  silenceStart: number | null;
  speechStart: number | null;
  currentAudioLevel: number;
  
  // Audio components
  audioContext: AudioContext | null;
  mediaRecorder: MediaRecorder | null;
  mediaStream: MediaStream | null;
  analyserNode: AnalyserNode | null;
  vadLoop: number | null;
  audioChunks: Blob[];
  
  // Results
  transcription: string | null;
  response: string | null;
  error: string | null;
  capabilities: VoiceCapabilities | null;
  timings: VoiceTimings | null;
};

export type VoiceCapabilities = {
  whisperAvailable: boolean;
  ffmpegAvailable: boolean;
  sagAvailable: boolean;
  sagAuthenticated: boolean;
  macosSayAvailable: boolean;
  personaplexAvailable: boolean;
  personaplexInstalled: boolean;
  personaplexRunning: boolean;
  personaplexDeps: {
    opus: boolean;
    moshi: boolean;
    accelerate: boolean;
  };
};

export type VoiceTimings = {
  sttMs?: number;
  routingMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs: number;
};

export type VoiceStatusResult = {
  enabled: boolean;
  mode: string;
  sttProvider: string;
  ttsProvider: string;
  capabilities: VoiceCapabilities;
  streaming: boolean;
};

export type VoiceProcessResult = {
  sessionId: string;
  transcription?: string;
  response?: string;
  audioBase64?: string;
  route?: string;
  model?: string;
  thinkingLevel?: string;
  runId?: string;
  timings?: VoiceTimings;
};

export type VoiceSynthesizeResult = {
  audioBase64?: string;
  audioPath?: string;
  provider: string;
  latencyMs?: number;
  warning?: string;
};

/**
 * Create initial voice state.
 */
export function createVoiceState(): VoiceState {
  return {
    client: null,
    connected: false,
    enabled: false,
    mode: "personaplex", // Default to PersonaPlex S2S
    sessionKey: null,
    driveOpenClaw: true,
    
    // Conversation state
    conversationActive: false,
    phase: "idle",
    
    // VAD state
    speechDetected: false,
    silenceStart: null,
    speechStart: null,
    currentAudioLevel: 0,
    
    // Audio components
    audioContext: null,
    mediaRecorder: null,
    mediaStream: null,
    analyserNode: null,
    vadLoop: null,
    audioChunks: [],
    
    // Results
    transcription: null,
    response: null,
    error: null,
    capabilities: null,
    timings: null,
  };
}

/**
 * Load voice status from gateway.
 */
export async function loadVoiceStatus(state: VoiceState): Promise<void> {
  if (!state.client || !state.connected) return;

  try {
    const result = (await state.client.request(
      "voice.status",
      {},
    )) as VoiceStatusResult;

    state.enabled = result.enabled;
    state.mode = result.mode as VoiceState["mode"];
    state.capabilities = result.capabilities;
    state.error = null;
  } catch (err) {
    state.error = String(err);
  }
}

/**
 * Setup Voice Activity Detection using Web Audio API.
 * Monitors audio levels to detect speech start/end.
 */
function setupVAD(
  state: VoiceState,
  stream: MediaStream,
  onSpeechEnd: () => void,
  onUpdate: () => void,
): void {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  
  state.audioContext = audioContext;
  state.analyserNode = analyser;
  
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  function checkAudioLevel() {
    if (!state.conversationActive || state.phase !== "listening") {
      return;
    }
    
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    state.currentAudioLevel = average;
    
    const now = Date.now();
    
    // Detect speech start
    if (average > VAD_SPEECH_THRESHOLD) {
      if (!state.speechDetected) {
        state.speechDetected = true;
        state.speechStart = now;
        state.silenceStart = null;
        onUpdate();
      } else {
        // Reset silence timer if speaking again
        state.silenceStart = null;
      }
    }
    // Detect silence after speech
    else if (state.speechDetected && average < VAD_SILENCE_THRESHOLD) {
      if (!state.silenceStart) {
        state.silenceStart = now;
      } else if (now - state.silenceStart > VAD_SILENCE_DURATION_MS) {
        // Check minimum speech duration
        const speechDuration = state.speechStart ? (state.silenceStart - state.speechStart) : 0;
        if (speechDuration >= VAD_MIN_SPEECH_MS) {
          // Silence detected after valid speech - trigger processing
          onSpeechEnd();
          return;
        } else {
          // Speech too short, reset and keep listening
          state.speechDetected = false;
          state.silenceStart = null;
          state.speechStart = null;
        }
      }
    }
    
    state.vadLoop = requestAnimationFrame(checkAudioLevel);
  }
  
  checkAudioLevel();
}

/**
 * Stop VAD monitoring.
 */
function stopVAD(state: VoiceState): void {
  if (state.vadLoop !== null) {
    cancelAnimationFrame(state.vadLoop);
    state.vadLoop = null;
  }
  state.analyserNode = null;
}

/**
 * Start recording with VAD.
 */
async function startRecordingWithVAD(
  state: VoiceState,
  onSpeechEnd: () => void,
  onUpdate: () => void,
): Promise<boolean> {
  try {
    // Request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
    
    state.mediaStream = stream;
    
    // Setup VAD monitoring
    setupVAD(state, stream, onSpeechEnd, onUpdate);
    
    // Create MediaRecorder
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    
    state.mediaRecorder = new MediaRecorder(stream, { mimeType });
    state.audioChunks = [];
    
    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.audioChunks.push(event.data);
      }
    };
    
    state.mediaRecorder.start(100);
    state.phase = "listening";
    state.speechDetected = false;
    state.silenceStart = null;
    state.speechStart = null;
    state.error = null;
    
    return true;
  } catch (err) {
    state.error = `Microphone access denied: ${err}`;
    return false;
  }
}

/**
 * Stop recording and get audio blob.
 */
function stopRecordingGetAudio(state: VoiceState): Promise<Blob | null> {
  return new Promise((resolve) => {
    stopVAD(state);
    
    if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") {
      resolve(state.audioChunks.length > 0 
        ? new Blob(state.audioChunks, { type: "audio/webm" })
        : null);
      return;
    }
    
    state.mediaRecorder.onstop = () => {
      const blob = state.audioChunks.length > 0
        ? new Blob(state.audioChunks, { type: state.mediaRecorder!.mimeType })
        : null;
      resolve(blob);
    };
    
    state.mediaRecorder.stop();
  });
}

/**
 * Cleanup all audio resources.
 */
function cleanupAudio(state: VoiceState): void {
  stopVAD(state);
  
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  state.mediaRecorder = null;
  
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  
  state.audioChunks = [];
  state.speechDetected = false;
  state.silenceStart = null;
  state.speechStart = null;
}

/**
 * Convert audio blob to base64.
 */
export async function audioToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Extract base64 part from data URL
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Process voice input through full pipeline.
 */
export async function processVoiceInput(
  state: VoiceState,
  audioBase64: string,
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) {
    console.error("[Voice] Not connected to gateway");
    return null;
  }

  state.error = null;
  state.transcription = null;
  state.response = null;
  state.timings = null;

  try {
    console.log("[Voice] Sending audio to gateway for processing...");
    const request: Record<string, unknown> = {
      audio: audioBase64,
      driveOpenClaw: state.driveOpenClaw,
    };
    if (state.sessionKey) {
      request.sessionKey = state.sessionKey;
    }
    const result = (await state.client.request("voice.process", {
      ...request,
    })) as VoiceProcessResult;

    console.log("[Voice] Got response:", {
      hasAudio: !!result.audioBase64,
      audioLength: result.audioBase64?.length ?? 0,
      transcription: result.transcription,
    });

    state.transcription = result.transcription ?? null;
    state.response = result.response ?? null;
    state.timings = result.timings ?? null;

    return result;
  } catch (err) {
    console.error("[Voice] Processing error:", err);
    state.error = String(err);
    return null;
  }
}

/**
 * Process text through voice pipeline (skip STT).
 */
export async function processTextToVoice(
  state: VoiceState,
  text: string,
): Promise<VoiceProcessResult | null> {
  if (!state.client || !state.connected) return null;

  state.error = null;
  state.transcription = text;
  state.response = null;
  state.timings = null;

  try {
    const result = (await state.client.request("voice.processText", {
      text,
      sessionKey: state.sessionKey ?? undefined,
      driveOpenClaw: state.driveOpenClaw,
    })) as VoiceProcessResult;

    state.response = result.response ?? null;
    state.timings = result.timings ?? null;

    return result;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Transcribe audio only (no LLM/TTS).
 */
export async function transcribeAudio(
  state: VoiceState,
  audioBase64: string,
): Promise<string | null> {
  if (!state.client || !state.connected) return null;

  try {
    const result = (await state.client.request("voice.transcribe", {
      audio: audioBase64,
    })) as { text?: string };

    return result.text ?? null;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Synthesize speech from text.
 */
export async function synthesizeSpeech(
  state: VoiceState,
  text: string,
): Promise<VoiceSynthesizeResult | null> {
  if (!state.client || !state.connected) return null;

  try {
    const result = (await state.client.request("voice.synthesize", {
      text,
    })) as VoiceSynthesizeResult;

    return result;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

/**
 * Play audio from base64.
 * Returns a promise that resolves when playback completes.
 */
export async function playAudioBase64(base64: string, state?: VoiceState): Promise<void> {
  console.log("[Voice] Playing audio, length:", base64.length);
  
  try {
    const audioData = atob(base64);
    const arrayBuffer = new ArrayBuffer(audioData.length);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < audioData.length; i++) {
      view[i] = audioData.charCodeAt(i);
    }

    const playbackContext = new AudioContext();
    console.log("[Voice] AudioContext created, decoding audio...");
    
    const audioBuffer = await playbackContext.decodeAudioData(arrayBuffer);
    console.log("[Voice] Audio decoded, duration:", audioBuffer.duration, "seconds");

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackContext.destination);
    
    if (state) {
      state.phase = "speaking";
    }
    
    source.start(0);
    console.log("[Voice] Audio playback started");

    return new Promise((resolve) => {
      source.onended = () => {
        console.log("[Voice] Audio playback finished");
        playbackContext.close();
        resolve();
      };
    });
  } catch (err) {
    console.error("[Voice] Audio playback error:", err);
    throw err;
  }
}

/**
 * Start a natural conversational voice session.
 * 
 * Flow:
 * 1. Click to start → mic goes live, listening begins
 * 2. Speak → VAD detects speech
 * 3. Stop speaking → VAD detects silence → auto-process
 * 4. AI responds with audio → auto-play
 * 5. After response → auto-listen again
 * 6. Click to stop → conversation ends
 */
export async function startConversation(
  state: VoiceState,
  onUpdate: () => void,
  onProcess: (audioBase64: string) => Promise<VoiceProcessResult | null>,
): Promise<void> {
  if (state.conversationActive) return;
  
  console.log("[Voice] Starting conversation...");
  state.conversationActive = true;
  state.phase = "listening";
  state.error = null;
  state.transcription = null;
  state.response = null;
  onUpdate();
  
  // Conversation loop - continues until user clicks stop
  while (state.conversationActive && state.connected && state.enabled) {
    try {
      console.log("[Voice] Starting new turn, phase: listening");
      
      // Promise that resolves when VAD detects end of speech
      let speechEndResolve: () => void;
      const speechEndPromise = new Promise<void>((resolve) => {
        speechEndResolve = resolve;
      });
      
      // Start recording with VAD
      const recordSuccess = await startRecordingWithVAD(
        state,
        () => {
          console.log("[Voice] VAD detected silence after speech");
          speechEndResolve();
        },
        onUpdate,
      );
      
      if (!recordSuccess) {
        console.error("[Voice] Failed to start recording");
        state.error = "Failed to start recording";
        break;
      }
      console.log("[Voice] Recording started, waiting for speech...");
      onUpdate();
      
      // Wait for VAD to detect end of speech (or conversation to be stopped)
      await Promise.race([
        speechEndPromise,
        waitForConversationEnd(state),
      ]);
      
      // If conversation was stopped, exit
      if (!state.conversationActive) {
        console.log("[Voice] Conversation stopped by user");
        break;
      }
      
      // Stop recording and get audio
      console.log("[Voice] Getting recorded audio...");
      state.phase = "processing";
      onUpdate();
      
      const audioBlob = await stopRecordingGetAudio(state);
      console.log("[Voice] Audio blob size:", audioBlob?.size ?? 0);
      
      if (!audioBlob || audioBlob.size === 0) {
        console.log("[Voice] No audio recorded, restarting listening");
        state.phase = "listening";
        state.speechDetected = false;
        continue;
      }
      
      // Process the audio through PersonaPlex S2S
      console.log("[Voice] Processing audio...");
      const base64 = await audioToBase64(audioBlob);
      state.audioChunks = [];
      
      const result = await onProcess(base64);
      console.log("[Voice] Process result:", {
        hasResult: !!result,
        hasAudio: !!result?.audioBase64,
        error: state.error,
      });
      onUpdate();
      
      // If conversation was stopped during processing, exit
      if (!state.conversationActive) break;
      
      // Play the response
      if (result?.audioBase64) {
        console.log("[Voice] Playing audio response...");
        state.phase = "speaking";
        onUpdate();
        await playAudioBase64(result.audioBase64, state);
        onUpdate();
      }
      
      // If conversation was stopped during playback, exit
      if (!state.conversationActive) break;
      
      // Brief pause before next listening cycle
      await new Promise(r => setTimeout(r, 300));
      
      // Reset for next turn
      state.phase = "listening";
      state.speechDetected = false;
      state.silenceStart = null;
      state.speechStart = null;
      onUpdate();
      
    } catch (err) {
      state.error = String(err);
      onUpdate();
      // Try to continue conversation despite error
      state.phase = "listening";
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  // Cleanup
  cleanupAudio(state);
  state.conversationActive = false;
  state.phase = "idle";
  onUpdate();
}

/**
 * Wait for conversation to end (user clicks stop).
 */
async function waitForConversationEnd(state: VoiceState): Promise<void> {
  while (state.conversationActive) {
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Stop the conversation completely.
 * Called when user clicks the stop button.
 */
export function stopConversation(state: VoiceState): void {
  state.conversationActive = false;
  cleanupAudio(state);
  state.phase = "idle";
}

/**
 * Check if browser supports voice features.
 */
export function checkBrowserSupport(): {
  supported: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!navigator.mediaDevices?.getUserMedia) {
    issues.push("Microphone API not supported");
  }

  if (!window.MediaRecorder) {
    issues.push("MediaRecorder not supported");
  }

  if (!window.AudioContext) {
    issues.push("AudioContext not supported");
  }

  return {
    supported: issues.length === 0,
    issues,
  };
}
