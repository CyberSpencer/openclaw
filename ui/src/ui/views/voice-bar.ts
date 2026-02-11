/**
 * Voice bar component for the web UI.
 *
 * Provides a natural conversational voice interface:
 * - Click to start conversation (mic goes live)
 * - VAD auto-detects when you stop speaking
 * - AI responds, then auto-listens again
 * - Click to end conversation
 */

import { html, nothing } from "lit";
import type { VoiceState, VoiceCapabilities, VoiceTimings } from "../controllers/voice.ts";
import { icons } from "../icons.ts";

export type VoiceBarProps = {
  state: VoiceState;
  visible: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onDriveOpenClawChange: (enabled: boolean) => void;
  onStartConversation: () => void;
  onStopConversation: () => void;
  onClose: () => void;
  onRetry: () => void;
};

function renderCapabilityIndicator(capabilities: VoiceCapabilities | null) {
  if (!capabilities) {
    return nothing;
  }

  const items = [
    {
      label: "Whisper STT",
      available: capabilities.whisperAvailable,
    },
    {
      label: "FFmpeg",
      available: capabilities.ffmpegAvailable,
    },
    {
      label: "ElevenLabs TTS",
      available: capabilities.sagAvailable && capabilities.sagAuthenticated,
    },
    {
      label: "macOS TTS",
      available: capabilities.macosSayAvailable,
    },
    {
      label: "PersonaPlex S2S",
      available: capabilities.personaplexAvailable,
    },
    {
      label: "Opus Codec",
      available: capabilities.personaplexDeps?.opus ?? false,
    },
    {
      label: "Moshi",
      available: capabilities.personaplexDeps?.moshi ?? false,
    },
    {
      label: "Accelerate",
      available: capabilities.personaplexDeps?.accelerate ?? false,
    },
  ];

  return html`
    <div class="voice-bar__capabilities">
      ${items.map(
        (item) => html`
          <span
            class="voice-bar__capability ${item.available ? "voice-bar__capability--available" : "voice-bar__capability--unavailable"}"
            title="${item.label}: ${item.available ? "Available" : "Not available"}"
          >
            ${item.available ? icons.check : icons.x}
            ${item.label}
          </span>
        `,
      )}
    </div>
  `;
}

function renderTimings(timings: VoiceTimings | null) {
  if (!timings) {
    return nothing;
  }

  const items = [
    { label: "STT", value: timings.sttMs },
    { label: "Route", value: timings.routingMs },
    { label: "LLM", value: timings.llmMs },
    { label: "TTS", value: timings.ttsMs },
    { label: "Total", value: timings.totalMs },
  ].filter((item) => item.value != null);

  return html`
    <div class="voice-bar__timings">
      ${items.map(
        (item) => html`
          <span class="voice-bar__timing">
            <span class="voice-bar__timing-label">${item.label}</span>
            <span class="voice-bar__timing-value">${item.value}ms</span>
          </span>
        `,
      )}
    </div>
  `;
}

function renderRecordingIndicator(isRecording: boolean) {
  if (!isRecording) {
    return nothing;
  }

  return html`
    <div class="voice-bar__recording">
      <span class="voice-bar__recording-dot"></span>
      <span class="voice-bar__recording-text">Recording...</span>
    </div>
  `;
}

function renderProcessingIndicator(isProcessing: boolean) {
  if (!isProcessing) {
    return nothing;
  }

  return html`
    <div class="voice-bar__processing">
      ${icons.loader}
      <span>Processing...</span>
    </div>
  `;
}

function renderTranscription(transcription: string | null) {
  if (!transcription) {
    return nothing;
  }

  return html`
    <div class="voice-bar__transcription">
      <span class="voice-bar__label">You said:</span>
      <p class="voice-bar__text">${transcription}</p>
    </div>
  `;
}

function renderResponse(response: string | null) {
  if (!response) {
    return nothing;
  }

  return html`
    <div class="voice-bar__response">
      <span class="voice-bar__label">Response:</span>
      <p class="voice-bar__text">${response}</p>
    </div>
  `;
}

function renderError(error: string | null, onRetry: () => void) {
  if (!error) {
    return nothing;
  }

  return html`
    <div class="voice-bar__error">
      <span class="voice-bar__error-text">${error}</span>
      <button class="btn" type="button" @click=${onRetry}>Retry</button>
    </div>
  `;
}

export function renderVoiceBar(props: VoiceBarProps) {
  if (!props.visible) {
    return nothing;
  }

  const {
    state,
    expanded,
    onToggleExpanded,
    onDriveOpenClawChange,
    onStartConversation,
    onStopConversation,
    onClose,
    onRetry,
  } = props;

  const canStart = state.connected && state.enabled && !state.conversationActive;
  const isActive = state.conversationActive;
  const isRecording = isActive && state.phase === "listening";

  // Simple toggle: start or stop conversation
  const mainButtonLabel = isActive ? "End Conversation" : "Start Conversation";

  const handleMainClick = () => {
    if (isActive) {
      onStopConversation();
    } else {
      onStartConversation();
    }
  };

  return html`
    <div class="voice-bar ${expanded ? "voice-bar--expanded" : ""} ${isActive ? "voice-bar--active" : ""}">
      <div class="voice-bar__header">
        <button
          class="voice-bar__toggle"
          type="button"
          @click=${onToggleExpanded}
          title="${expanded ? "Collapse" : "Expand"}"
        >
          ${expanded ? icons.chevronDown || "▼" : icons.chevronUp || "▲"}
        </button>
        <span class="voice-bar__title">Voice Conversation</span>
        <span class="voice-bar__mode">${state.driveOpenClaw ? "Tools" : state.mode === "personaplex" ? "S2S" : state.mode === "spark" ? "Spark" : state.mode}</span>
        <button
          class="voice-bar__close"
          type="button"
          @click=${onClose}
          title="Close voice bar"
        >
          ${icons.x}
        </button>
      </div>

      <div class="voice-bar__main">
        <button
          class="voice-bar__mic ${isRecording ? "voice-bar__mic--recording" : ""}"
          type="button"
          ?disabled=${!canStart && !isActive}
          @click=${handleMainClick}
          title=${mainButtonLabel}
          aria-label=${mainButtonLabel}
        >
          ${icons.mic || "🎤"}
        </button>
        
        <div class="voice-bar__status">
          ${
            state.conversationActive && state.phase === "listening"
              ? renderRecordingIndicator(true)
              : nothing
          }
          ${
            state.conversationActive && state.phase === "processing"
              ? renderProcessingIndicator(true)
              : nothing
          }
          ${
            state.conversationActive && state.phase === "speaking"
              ? html`<div class="voice-bar__processing">${icons.loader}<span>Speaking...</span></div>`
              : nothing
          }
        </div>
      </div>

      ${
        expanded
          ? html`
            <div class="voice-bar__details">
              <label class="field checkbox voice-bar__parity-toggle">
                <input
                  type="checkbox"
                  .checked=${state.driveOpenClaw}
                  @change=${(e: Event) =>
                    onDriveOpenClawChange((e.target as HTMLInputElement).checked)}
                />
                <span title="When enabled, voice uses the normal chat agent pipeline (tools, memory, routing).">
                  Drive OpenClaw (tools)
                </span>
              </label>
              ${renderCapabilityIndicator(state.capabilities)}
              ${renderTimings(state.timings)}
              ${renderTranscription(state.transcription)}
              ${renderResponse(state.response)}
              ${renderError(state.error, onRetry)}
            </div>
          `
          : nothing
      }

      ${
        !state.enabled
          ? html`
              <div class="voice-bar__disabled">Voice mode is disabled. Enable it in settings.</div>
            `
          : nothing
      }

      ${
        !state.connected
          ? html`
              <div class="voice-bar__disconnected">Not connected to gateway.</div>
            `
          : nothing
      }
    </div>
  `;
}

/**
 * Voice bar CSS styles (to be added to styles/components.css)
 */
export const voiceBarStyles = `
/* Voice Bar Component */
.voice-bar {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  min-width: 320px;
  max-width: 400px;
  z-index: 1000;
  overflow: hidden;
  transition: all 0.3s ease;
}

.voice-bar--expanded {
  max-width: 450px;
}

.voice-bar--active {
  border-color: var(--primary-color, #007bff);
  box-shadow: 0 4px 24px rgba(0, 123, 255, 0.25);
}

.voice-bar__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  background: var(--header-bg, #f8f9fa);
}

.voice-bar__toggle {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  color: var(--text-muted, #666);
}

.voice-bar__title {
  font-weight: 600;
  flex: 1;
}

.voice-bar__mode {
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  color: white;
  font-weight: 500;
}

.voice-bar__close {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  color: var(--text-muted, #666);
}

.voice-bar__main {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
}

/* Conversation button - main interaction element */
.voice-bar__conversation-btn {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 3px solid var(--primary-color, #007bff);
  background: var(--card-bg, #fff);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  transition: all 0.3s ease;
  position: relative;
}

.voice-bar__conversation-btn:hover:not(:disabled) {
  background: var(--primary-color, #007bff);
  color: white;
  transform: scale(1.05);
}

.voice-bar__conversation-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-bar__conversation-btn--active {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-color: transparent;
  color: white;
  animation: glow 2s ease-in-out infinite;
}

@keyframes glow {
  0%, 100% { box-shadow: 0 0 20px rgba(102, 126, 234, 0.4); }
  50% { box-shadow: 0 0 30px rgba(102, 126, 234, 0.7); }
}

/* Audio wave animation */
.voice-bar__waves {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 30px;
}

.voice-bar__waves span {
  width: 4px;
  height: 100%;
  background: white;
  border-radius: 2px;
  animation: wave 1s ease-in-out infinite;
}

.voice-bar__waves span:nth-child(1) { animation-delay: 0s; }
.voice-bar__waves span:nth-child(2) { animation-delay: 0.1s; }
.voice-bar__waves span:nth-child(3) { animation-delay: 0.2s; }
.voice-bar__waves span:nth-child(4) { animation-delay: 0.3s; }

@keyframes wave {
  0%, 100% { height: 8px; }
  50% { height: 24px; }
}

/* Conversation status */
.voice-bar__conversation-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 20px;
  font-size: 0.875rem;
  font-weight: 500;
}

.voice-bar__status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  animation: pulse-dot 1.5s infinite;
}

.voice-bar__status--listening {
  background: rgba(40, 167, 69, 0.1);
  color: #28a745;
}

.voice-bar__status--listening .voice-bar__status-indicator {
  background: #28a745;
}

.voice-bar__status--processing {
  background: rgba(0, 123, 255, 0.1);
  color: #007bff;
}

.voice-bar__status--processing .voice-bar__status-indicator {
  background: #007bff;
}

.voice-bar__status--speaking {
  background: rgba(118, 75, 162, 0.1);
  color: #764ba2;
}

.voice-bar__status--speaking .voice-bar__status-indicator {
  background: #764ba2;
}

.voice-bar__status--ready {
  background: rgba(108, 117, 125, 0.1);
  color: #6c757d;
}

.voice-bar__status--ready .voice-bar__status-indicator {
  background: #6c757d;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.2); }
}

/* Legacy mic button styles (kept for compatibility) */
.voice-bar__mic {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 2px solid var(--primary-color, #007bff);
  background: var(--card-bg, #fff);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  transition: all 0.2s ease;
}

.voice-bar__mic:hover:not(:disabled) {
  background: var(--primary-color, #007bff);
  color: white;
}

.voice-bar__mic:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-bar__mic--recording {
  background: #dc3545;
  border-color: #dc3545;
  color: white;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.voice-bar__recording {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #dc3545;
}

.voice-bar__recording-dot {
  width: 8px;
  height: 8px;
  background: #dc3545;
  border-radius: 50%;
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.voice-bar__processing {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--primary-color, #007bff);
}

.voice-bar__details {
  padding: 1rem;
  border-top: 1px solid var(--border-color, #e0e0e0);
}

.voice-bar__capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.voice-bar__capability {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.voice-bar__capability--available {
  background: #d4edda;
  color: #155724;
}

.voice-bar__capability--unavailable {
  background: #f8d7da;
  color: #721c24;
}

.voice-bar__timings {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.75rem;
}

.voice-bar__timing {
  display: flex;
  gap: 0.25rem;
}

.voice-bar__timing-label {
  color: var(--text-muted, #666);
}

.voice-bar__timing-value {
  font-weight: 600;
}

.voice-bar__transcription,
.voice-bar__response {
  margin-bottom: 1rem;
}

.voice-bar__label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
  margin-bottom: 0.25rem;
}

.voice-bar__text {
  margin: 0;
  padding: 0.5rem;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
  font-size: 0.875rem;
  line-height: 1.4;
}

.voice-bar__play-btn {
  margin-top: 0.5rem;
}

.voice-bar__error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: #f8d7da;
  border-radius: 4px;
  color: #721c24;
}

.voice-bar__error-text {
  flex: 1;
  font-size: 0.875rem;
}

.voice-bar__disabled,
.voice-bar__disconnected {
  padding: 0.75rem 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-muted, #666);
  background: var(--bg-secondary, #f5f5f5);
}
`;
