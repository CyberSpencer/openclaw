# Voice Telemetry (UI + Gateway)

This document describes per-turn voice metrics shown in the voice panel and emitted to UI logs.

## Metrics

Each voice turn exposes a `timings` object with these keys:

- `micStartMs`: time from turn start to active mic capture (includes stream/worklet/recorder startup)
- `firstSpeechMs`: time from mic start to first detected speech by VAD
- `sttMs`: speech-to-text duration
- `routingMs`: optional router time from backend
- `llmMs`: assistant generation duration
- `ttsMs`: text-to-speech duration
- `totalMs`: end-to-end turn duration

## Where to view

- **Voice panel** in the web UI (timings chips under the voice controls)
- Browser console logs: `[Voice/Telemetry] turn {...}`

## How to interpret

- High `micStartMs` means capture startup overhead, check permission churn, stream reuse, and worklet availability.
- High `firstSpeechMs` usually means user pause or VAD sensitivity mismatch, check ambient calibration.
- High `sttMs`, `llmMs`, or `ttsMs` isolates backend hotspots.
- `totalMs` is the user-visible turn latency and should trend down as each stage is optimized.
