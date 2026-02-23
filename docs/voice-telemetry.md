# Voice Telemetry (UI + Gateway)

This document describes per-turn voice metrics emitted by gateway + UI and shown in the voice panel.

## Timing shape

Each turn exposes a `timings` object.

Legacy top-level fields are retained for compatibility:

- `sttMs`
- `routingMs`
- `llmMs`
- `ttsMs`
- `totalMs`

Structured stage timings are exposed in `timings.stages`:

- `captureMs`: mic capture startup overhead
- `transcribeMs`: speech-to-text duration
- `routeMs`: voice route decision duration
- `llmMs`: generation duration
- `ttsMs`: text-to-speech duration
- `playbackMs`: client playback duration

Additional useful fields:

- `micStartMs`: turn start to active mic capture
- `firstSpeechMs`: mic start to first VAD speech detection
- `totalMs`: end-to-end turn duration

## Spark conversational playback telemetry

Spark conversational flow currently uses:

1. `spark.voice.stt`
2. `voice.processText` (`skipTts: true`)
3. `spark.voice.tts`

The UI now supports progressive playback for long responses:

- first chunk is synthesized and played immediately
- remaining chunks are synthesized and played in-order
- additional chunk synthesis time is accumulated into `timings.ttsMs`
- total playback time is recorded in `timings.playbackMs`

This improves perceived latency without requiring a gateway streaming method.

## Latency SLO evaluation

Voice latency SLO evaluation is implemented in:

- `src/voice/latency-slo.ts`
- `src/voice/latency-slo.test.ts`

Default budget tracks p95 for:

- first-audio latency
- total-turn latency
- transcribe latency
- llm latency
- tts latency

Eval suite coverage:

- suite id: `voice-latency-slo`
- wired in `src/evals/config.ts` for both local and CI profiles

## Where to view

- Voice panel in web UI (timing chips)
- browser console log entries (`[Voice/Telemetry] turn ...`)

## Practical interpretation

- High `captureMs` or `micStartMs`: capture init overhead, permission churn, stream/worklet setup
- High `firstSpeechMs`: VAD threshold mismatch or user pause
- High `transcribeMs` / `llmMs` / `ttsMs`: backend bottleneck by stage
- High `playbackMs`: long output or slow synthesis + playback chain
