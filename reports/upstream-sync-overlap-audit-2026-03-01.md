# Upstream Sync Overlap Audit (2026-03-01)

## Merge Context

- base branch: codex_spencer/upstream-sync-origin-main-20260301
- ours (pre-merge): 863a1b60770e1892c4836012fd6115cad98d13e7
- theirs (origin/main): 5d7314db225f5ab6db79362048a97e34443ab823
- overlap list: reports/upstream-sync-overlap-files-2026-03-01.txt

## Overlap Hotspot Counts

- 28 ui/src
- 16 src/gateway
- 8 src/config
- 7 src/agents
- 4 src/memory
- 4 src/cli
- 3 .github/workflows
- 2 src/media
- 1 src/voice
- 1 scripts/workspace-cleanup.sh
- 1 package.json/
- 1 extensions/tlon
- 1 docs/diagnostics
- 1 apps/shared
- 1 apps/macos

## Compatibility-Critical Interface Files

- src/gateway/protocol/schema.ts: mixed-or-manual
- src/gateway/protocol/schema/types.ts: mixed-or-manual
- src/gateway/server-methods-list.ts: custom-preserved
- src/config/zod-schema.ts: mixed-or-manual
- src/config/sync-schema-sync.test.ts: custom-preserved
- apps/macos/Sources/OpenClawProtocol/GatewayModels.swift: custom-preserved
- apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift: custom-preserved

## Continuity-Critical Custom Files

- ui/src/ui/gateway.ts: custom-preserved
- ui/src/ui/app-gateway.ts: custom-preserved
- src/gateway/config-reload.ts: mixed-or-manual
- src/cli/daemon-cli/status.gather.ts: custom-preserved
- src/cli/program/config-guard.ts: mixed-or-manual

## Note

- Strategy applied: upstream-first default, custom-preserved for files in aii-private/main..HEAD preservation set.
- Validate with strict gates before push/PR.
