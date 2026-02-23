---
summary: "Voice Action Mode: off/constrained/text-parity behavior, external-send confirmation, and request wiring"
read_when:
  - Working on Spark conversational voice mode
  - Debugging voice intent routing / confirmation safety
  - Auditing parity between text chat and voice chat behavior
---

# Voice Action Mode

Voice Action Mode controls how `voice.process` / `voice.processText` gate intent execution.

## Mode values

`voiceActionMode` accepts:

- `"off"` (or `false`)
- `"constrained"` (or `true`, or `"safe"`)
- `"text-parity"` (or `"parity"` / `"full"`)

Normalization is handled by `normalizeVoiceActionMode()` in `src/voice/action-mode.ts`.

## Behavior by mode

### 1) `off`

- No voice-action safety classification is applied.
- Input text is passed through directly to normal processing.

### 2) `constrained`

- Utterance is classified into a voice intent.
- Allowlisted intents execute directly:
  - `status`
  - `triage`
  - `draft`
  - `schedule`
- Non-allowlisted intents are blocked with guidance.
- `external_send` requires explicit confirmation before execution.

### 3) `text-parity`

- Keeps the external-send confirmation safety gate.
- For non-send intents, preserves text-like behavior (does not block unknown intents).
- This is the default UI conversational mode (`state.actionMode = "text-parity"`).

## External-send confirmation gate

`external_send` requests are blocked until explicit confirmation.

Flow:

1. User asks to send (`send`, `text`, `email`, etc.)
2. Gateway stores pending send request keyed by `sessionKey`
3. Gateway returns confirmation-required response
4. User says `confirm send` -> pending request is replayed
5. User says `cancel` -> pending request is discarded

Config knobs:

- `OPENCLAW_VOICE_ACTION_MODE_ENABLED` (default `true`)
- `OPENCLAW_VOICE_ACTION_ALLOWED_INTENTS` (CSV subset of allowlist)
- `OPENCLAW_VOICE_ACTION_REQUIRE_CONFIRM_SEND` (default `true`)
- `OPENCLAW_VOICE_ACTION_CONFIRM_TTL_MS` (default `120000`)

## Request wiring

### Gateway methods

- `voice.process` and `voice.processText` accept `voiceActionMode`
- Documented mode surface: `"constrained" | "text-parity" | true/false`

### UI Spark conversational flow

In `ui/src/ui/controllers/voice.ts` Spark turns call:

- `spark.voice.stt`
- `voice.processText` with:
  - `driveOpenClaw: true`
  - `voiceActionMode: state.actionMode`
  - `skipTts: true`
- `spark.voice.tts` for synthesis/playback

So voice now follows explicit mode semantics rather than hardcoded `voiceActionMode: true`.
