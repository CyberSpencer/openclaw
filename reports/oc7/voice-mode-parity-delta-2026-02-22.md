# OC7 Voice Mode Parity Delta Update (2026-02-22, evening)

## Scope of this delta

Follow-up execution after initial OC7 integration acceptance to close the requested P0 voice parity/latency slice:

1. Mode-aware conversational behavior (`off` vs `constrained` vs `text-parity`)
2. Faster first-audio path for Spark conversational mode
3. Explicit latency SLO gate coverage in eval harness
4. Type-safety cleanup in gateway/UI voice paths

## Code changes shipped in this slice

### 1) Voice action mode normalization and gateway behavior split

- Added `VoiceActionMode` + `normalizeVoiceActionMode()` in `src/voice/action-mode.ts`
  - accepted inputs: `true/false`, `constrained|safe`, `text-parity|parity|full`, `off|disabled`
- Updated gateway flow in `src/gateway/server-methods/voice.ts`:
  - `voiceActionMode` is now mode-based (not boolean-only)
  - `resolveVoiceActionDecision()` now branches by mode:
    - `off`: pass-through
    - `text-parity`: preserve generic text intent behavior, still retain external-send confirmation guard
    - `constrained`: enforce allowlisted intent scaffolding and confirmation policy
- Updated tests in `src/gateway/server-methods/voice.process-text.test.ts`
  - added explicit text-parity behavior coverage

### 2) Spark conversational first-audio optimization

- Updated UI voice controller in `ui/src/ui/controllers/voice.ts`:
  - split synthesized reply into chunks
  - synthesize and play first chunk immediately
  - synthesize/play remaining chunks progressively with barge-in awareness
  - accumulate additional chunk TTS + playback timings into telemetry payload
- Extended `VoiceProcessResult` contract to include `pendingSpeechChunks` for follow-up synthesis
- Added/updated tests in `ui/src/ui/controllers/voice.spark-conversation.test.ts` for chunk queue behavior and mode forwarding

### 3) Latency SLO evaluator + eval integration

- Added `src/voice/latency-slo.ts`
  - computes p95 for first-audio, total-turn, transcribe, LLM, and TTS stages
  - reports explicit budget breaches
- Added tests `src/voice/latency-slo.test.ts`
- Wired new eval suite in `src/evals/config.ts`
  - suite id: `voice-latency-slo`
  - thresholds added for both `local` and `ci` profiles

## Validation evidence

### Typecheck + tests

- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` -> **PASS**
- Targeted voice/gateway tests -> **PASS (24/24)**
- UI tests (including spark voice conversation + browser pack) -> **PASS (162/162)**

### Evals

- `pnpm evals` -> **PASS (43/43)**
- `pnpm evals:ci` -> **PASS (43/43)**
  - messaging-routing 24/24
  - orchestration-lifecycle 6/6
  - voice-action-safety 10/10
  - voice-latency-slo 3/3

## Manual smoke checks run

### Runtime + voice diagnostics

- `openclaw status` -> gateway healthy, dashboard reachable
- `scripts/status_plus.sh` -> stack healthy (voice soft caveat remains non-blocking)
- `scripts/diagnose.sh voice` -> PersonaPlex local component absent (known caveat)
- `scripts/validate_contract.sh` -> PASS with warning: DGX PersonaPlex not reachable

### Control UI smoke

- Dashboard loaded successfully at `http://127.0.0.1:32555/`
- Chat + navigation surfaces rendered correctly in browser snapshot
- DGX page indicated environment not enabled in this runtime (`DGX_ENABLED`/`DGX_HOST` gating), so live DGX voice path could not be fully exercised from this host profile during this smoke pass

## Net outcome

- Requested parity/latency slice is implemented and validated in CI-safe gates.
- Prior TS blockers are resolved.
- Remaining live caveat is environment-level DGX/PersonaPlex availability semantics, not integration branch correctness.
