# Custom Preservation Manifest (2026-03-01)

## Purpose
Preserve custom/private behavior while integrating latest `origin/main` into current custom branch.

## Required Non-Regression Contracts
1. Terminal auth failures do not reconnect-loop in Control UI transport.
2. Auth disconnects render actionable remediation text in Settings/Chat UI.
3. `voice.personaplex.endpoints` remains no-op/non-restart classification in config reload.
4. `openclaw daemon status --json` remains usable under invalid env-substituted config and includes control UI root + gateway probe details.
5. Existing DGX/session continuity behavior in gateway+ui remains intact.

## Commit Preservation Set (`aii-private/main..HEAD`)
- fe6145dd1 feat(voice): ship STT latency contract and live-smoke closure
- 17826e5de config(sync): allow runtime-only workspace extensions in schema guard
- e9be62b0e feat: batch pending memory+routing+voice updates
- a24703732 fix: address CodeRabbit reliability and safety feedback
- 74180332d fix: close remaining CodeRabbit comments on PR 92
- 59047c72b fix: resume voice loop when fallback approvals expire
- 12b5b2a76 fix: keep spark mic queue draining on per-chunk errors
- 7f8265ae5 chore: lower spark mic telemetry console noise
- 77eee491a fix: force voice approval resume on external resolve
- 8f8e78836 fix: align voice approval resolve meta typing
- fb63353a7 refactor(ui,memory): extract spark mic and qdrant resolver helpers
- 9acad39e4 refactor(ui): split usage view shared analytics/query helpers
- c7d921848 refactor(ui): decompose usage view into focused helper modules
- 7cf84a4ac fix(session): harden auth reconnect continuity and daemon status fallbacks
- 863a1b607 refactor(ui): split usage session detail panels into focused modules

## Behavior-to-Test Mapping
- Auth reconnect terminal behavior:
  - `ui/src/ui/gateway.ts`
  - Test: `ui/src/ui/gateway.auth-reconnect.test.ts`
- Auth disconnect remediation UX:
  - `ui/src/ui/app-gateway.ts`
  - Test: `ui/src/ui/app-gateway.disconnect-message.test.ts`
- Config reload no-op rule:
  - `src/gateway/config-reload.ts`
  - Test: `src/gateway/config-reload.test.ts`
- Daemon invalid-config fallback:
  - `src/cli/program/config-guard.ts`
  - `src/cli/daemon-cli/status.gather.ts`
  - Tests: `src/cli/program/config-guard.test.ts`, `src/cli/daemon-cli.coverage.test.ts`
- Path/state-dir robustness:
  - `src/config/paths.ts`
  - Test: `src/config/paths.test.ts`
- Subagent lineage warning parity:
  - `src/agents/subagent-announce.ts`
  - Test: `src/agents/subagent-announce.format.test.ts`

## Manual Semantic Review Hotspots
- `ui/src/ui/*` (auth/reconnect/session continuity paths)
- `src/gateway/*` (method registration, reload classifications, protocol compatibility)
- `src/config/*` (schema + runtime substitution behavior)
- `src/agents/*` (run lifecycle/subagent announcement behavior)
- `src/cli/*` (status + invalid-config safety)

## Compatibility-Critical Interface Files
- `src/gateway/protocol/schema.ts`
- `src/gateway/protocol/schema/types.ts`
- `src/gateway/server-methods-list.ts`
- `src/config/zod-schema.ts`
- `src/config/sync-schema-sync.test.ts`
- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`

## Merge Resolution Policy
- Custom-first for continuity-critical UI/gateway/auth/session behavior.
- Upstream-first for generic security/tooling/infrastructure unless it breaks custom contracts.
- Document every conflict decision in PR body, including rationale and affected tests.
