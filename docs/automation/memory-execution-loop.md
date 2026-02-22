---
summary: "Turn memory decisions into tracked commitments with reminders and closure workflow"
read_when:
  - You want durable action tracking from memory notes
  - You want heartbeat/cron-compatible reminder output
---

# Memory-to-Execution Loop

Feature 5 adds a deterministic pipeline that converts decision-style memory records into tracked commitments.

## What gets extracted

Supported decision-style inputs include patterns like:

```md
## Decision: Ship feature 5 | owner: spencer | due: 2026-03-10 | status: in_progress

### Commitment: Publish runbook

owner: ops
due: 2026-03-09
status: open

- [ ] Action: Follow up QA @qa due: 2026-03-08
```

Extracted fields:

- `title`
- `owner` (normalized)
- `dueDate` (`YYYY-MM-DD`)
- `status` (`open|in_progress|blocked|done|cancelled`)
- `provenance` (`path`, line range, deterministic source hash)

Duplicate suppression uses a deterministic dedupe key (`title + owner + dueDate`).

## Store location

Tracked commitments are persisted per-agent at:

```text
<agentDir>/memory/commitments.v1.json
```

Writes are atomic and lock-guarded.

## CLI workflow

```bash
# 1) Ingest from memory markdown
openclaw memory commitments ingest --agent main

# 2) Query
openclaw memory commitments list --agent main --status open,in_progress

# 3) Update / close
openclaw memory commitments update cmt_abcd1234 --status blocked --note "Waiting on vendor"
openclaw memory commitments close cmt_abcd1234 --note "Delivered"

# 4) Reminder output
openclaw memory commitments check --mode heartbeat
openclaw memory commitments check --mode cron --window-hours 24
```

## Heartbeat / Cron integration

- Heartbeat-friendly:
  - `openclaw memory commitments check --mode heartbeat`
  - Returns `HEARTBEAT_OK` when nothing is due.
- Cron-friendly:
  - `openclaw memory commitments check --mode cron`
  - Returns concise plain text reminder lines.

Recommended cadence:

1. Run `ingest` before reminder checks.
2. Run `check` hourly or every few hours.
3. Resolve with `update` / `close` to keep reminders clean.
