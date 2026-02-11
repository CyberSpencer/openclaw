/**
 * Voice mode module exports.
 */

// Core voice orchestration
export {
  resolveVoiceConfig,
  checkVoiceCapabilities,
  generateSessionId,
  createVoiceSession,
  processVoiceInput,
  processTextToVoice,
  type VoiceProcessResult,
  type VoiceCapabilities,
} from "./voice.js";

// Local STT (whisper-cpp)
export {
  resolveWhisperConfig,
  isWhisperAvailable,
  transcribeWithWhisper,
  transcribeFileWithWhisper,
  prepareAudioForWhisper,
  type LocalSttResult,
  type LocalSttConfig,
} from "./local-stt.js";

// Local TTS (sag / macOS say)
export {
  resolveLocalTtsConfig,
  isSagAvailable,
  isMacosSayAvailable,
  synthesizeWithLocalTts,
  cleanupTtsCache,
  type LocalTtsResult,
  type LocalTtsConfig,
} from "./local-tts.js";

// Model router
export {
  resolveRouterConfig,
  detectSensitiveData,
  analyzeComplexity,
  routeVoiceRequest,
  type RouterDecision,
  type ResolvedRouterConfig,
} from "./router.js";

// PersonaPlex S2S (experimental)
export {
  resolvePersonaPlexConfig,
  isPersonaPlexInstalled,
  isPersonaPlexRunning,
  startPersonaPlexServer,
  stopPersonaPlexServer,
  processWithPersonaPlex,
  getPersonaPlexStatus,
  getHfToken,
  checkPersonaPlexDependencies,
  type PersonaPlexResult,
  type ResolvedPersonaPlexConfig,
  type PersonaPlexDependencies,
} from "./personaplex.js";
