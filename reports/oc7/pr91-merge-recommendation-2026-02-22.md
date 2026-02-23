# PR #91 Merge Recommendation (OC7 Voice Follow-Through)

Date: 2026-02-22
PR: https://github.com/AI-Integrations/openclaw-core/pull/91
Head: `jarvis/oc7-integration-20260222`
Base: `main` (repo currently has no `staging` branch)

## Executive recommendation

Recommend **merge-ready with low-to-moderate operational risk** after latest docs alignment.

Rationale:

- OC7 voice parity/latency slice is already integrated and test-validated.
- Docs drift is now corrected to match implemented behavior (no `voice.processStreaming` claim in this branch).
- Manual and automated acceptance evidence is green.

## What was closed in this follow-through

1. Docs drift cleanup for voice mode
   - Updated `docs/voice-action-mode.md` to reflect mode semantics:
     - `off` / `constrained` / `text-parity`
   - Updated `docs/voice-telemetry.md` to reflect progressive Spark chunk playback + latency SLO evaluator.
   - Added `docs/voice-conversational-mode.md` with current integrated pipeline and explicit note that `voice.processStreaming` is not active in this branch.

2. Merge recommendation package
   - This report captures risks and smoke evidence for decision support.

3. Type-safety stabilization carried in this PR slice
   - Includes the previously requested null-safe handling updates in UI voice chunk synthesis/queue flow (`ui/src/ui/controllers/voice.ts`) that restored clean TypeScript compilation.

## Smoke and acceptance evidence

### Local acceptance gates

- `pnpm evals` -> PASS (43/43)
  - messaging-routing 24/24
  - orchestration-lifecycle 6/6
  - voice-action-safety 10/10
  - voice-latency-slo 3/3
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` -> PASS
- `pnpm --dir ui test -- src/ui/controllers/voice.spark-conversation.test.ts` -> PASS
  - UI pack run result observed: 28 files, 162 tests passed

### Previously published integration evidence

- `reports/oc7/voice-mode-parity-delta-2026-02-22.md`

## Risk notes

### 1) CI coverage asymmetry on PR #91

Current PR checks are lightweight (labeling + CodeRabbit) and do not mirror full local acceptance matrix.

Mitigation:

- rely on explicit local acceptance artifacts above
- optionally trigger a fuller CI workflow before merge if desired

### 2) Voice infrastructure caveat (non-blocking to this PR)

PersonaPlex/DGX aggregate health semantics still produce soft-fail conditions in some diagnostics.

Mitigation:

- Spark STT/TTS conversational path remains validated
- keep PersonaPlex caveat tracked separately from this docs/parity merge

### 3) Branching/process caveat

This repo currently lacks a `staging` branch, so PR targets `main`.

Mitigation:

- treat as controlled mainline merge with rollback-ready commit history

## Merge recommendation details

Recommended action:

1. Merge PR #91 as a single unit (keeps OC7 integration coherent).
2. Immediately after merge, run one post-merge smoke:
   - voice conversational turn (Spark mode)
   - `pnpm evals`
   - `pnpm exec tsc --noEmit`
3. Keep Autobuild Step-4 KV/cache staging remediation in a separate lane (ongoing infra config-drift fix path; see workspace deep-dive: `reports/aii-autobuild-step4-kv-deep-dive-2026-02-22.md`).

## Decision

Status: **GO to merge PR #91**
Condition: maintain normal rollback readiness and run post-merge smoke.
