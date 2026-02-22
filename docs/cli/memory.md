---
summary: "CLI reference for `openclaw memory` (status/index/search/commitments)"
read_when:
  - You want to index or search semantic memory
  - You want to track commitments extracted from memory decisions
  - You’re debugging memory availability or indexing
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose

# Memory-to-Execution loop (Feature 5)
openclaw memory commitments ingest --agent main
openclaw memory commitments list --status open,in_progress
openclaw memory commitments update cmt_abcd1234 --status blocked --note "Waiting on API key"
openclaw memory commitments close cmt_abcd1234 --note "Shipped"
openclaw memory commitments check --mode heartbeat
openclaw memory commitments check --mode cron --window-hours 24
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.

## `memory commitments` subcommands

Use these to run the Memory-to-Execution loop:

- `memory commitments ingest`
  - Scans `MEMORY.md` + `memory/**/*.md` (+ `memorySearch.extraPaths`) for decision-style records.
  - Extracts deterministic fields: `title`, `owner`, `dueDate`, `status`, `provenance`.
  - Upserts into a tracked commitment store under the agent state dir.
- `memory commitments list`
  - Query commitments by status/owner/due window.
- `memory commitments update` / `memory commitments close`
  - Apply explicit state transitions and closure metadata.
- `memory commitments check`
  - Produces reminder output for automation:
    - `--mode heartbeat` returns `HEARTBEAT_OK` when there is nothing due.
    - `--mode cron` returns concise plain text for cron/system schedulers.

Tip: run `memory commitments ingest` before `memory commitments check` in scheduled workflows.
