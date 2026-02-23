# Voice Conversational Mode (Current Integrated Behavior)

This document reflects the current implementation in `jarvis/oc7-integration-20260222`.

## Current pipeline (Spark path)

For conversational turns in UI Spark mode:

1. Capture mic audio
2. Run STT via `spark.voice.stt`
3. Run text processing via `voice.processText` with `skipTts: true`
4. Run TTS via `spark.voice.tts`
5. Play response audio

## Important implementation note

There is no active `voice.processStreaming` method in the current integrated core branch.

The current low-latency improvement is client-side progressive synthesis/playback:

- split response into chunks
- synthesize first chunk immediately for faster first audio
- synthesize/play remaining chunks sequentially
- support barge-in interruption during playback

## Voice action mode wiring

Conversational turns pass `voiceActionMode: state.actionMode` where UI mode is:

- `"text-parity"` (default)
- `"constrained"`

This replaces the older hardcoded boolean path and aligns voice behavior with requested mode semantics.

## Telemetry expectations

Turn timings include stage fields and aggregate fields. In progressive playback turns:

- `ttsMs` includes additional chunk synthesis time
- `playbackMs` covers total playback duration
- `totalMs` is recalculated at turn completion

## Safety behavior

External-send intent still requires explicit confirmation when voice action safety is enabled, including in `text-parity` mode.

## Related docs

- `docs/voice-action-mode.md`
- `docs/voice-telemetry.md`
