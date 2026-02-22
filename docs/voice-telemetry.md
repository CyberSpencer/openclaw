# Voice Telemetry (UI + Gateway)

This document describes per-turn voice metrics shown in the voice panel and emitted to UI logs.

## Metrics

Each voice turn exposes a `timings` object.

Legacy top-level fields are preserved (`sttMs`, `routingMs`, `llmMs`, `ttsMs`, `totalMs`) and
Feature 6 adds a structured stage view under `timings.stages`:

- `captureMs`: capture startup overhead (mic stream + recorder/worklet ready)
- `transcribeMs`: speech-to-text duration
- `routeMs`: voice router decision duration
- `llmMs`: assistant generation duration
- `ttsMs`: text-to-speech duration
- `playbackMs`: client playback duration (when spoken audio is played)

Other useful top-level fields:

- `micStartMs`: time from turn start to active mic capture
- `firstSpeechMs`: time from mic start to first detected speech by VAD
- `totalMs`: end-to-end turn duration

## Where to view

- **Voice panel** in the web UI (timings chips under the voice controls)
- Browser console logs: `[Voice/Telemetry] turn {...}`

## How to interpret

- High `micStartMs` means capture startup overhead, check permission churn, stream reuse, and worklet availability.
- High `firstSpeechMs` usually means user pause or VAD sensitivity mismatch, check ambient calibration.
- High `sttMs`, `llmMs`, or `ttsMs` isolates backend hotspots.
- `totalMs` is the user-visible turn latency and should trend down as each stage is optimized.
