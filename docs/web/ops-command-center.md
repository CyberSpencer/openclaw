---
summary: "Ops Command Center snapshot for orchestrator, branch hygiene, and Spark/voice health"
read_when:
  - You operate OpenClaw remotely and need one-glance health
  - You want the gateway method contract for the ops snapshot
  - You are debugging stalled orchestration runs
title: "Ops Command Center"
---

# Ops Command Center

The Control UI **Overview** page now includes an **Ops Command Center** panel backed by
`ops.snapshot`.

It aggregates three surfaces:

1. **Orchestrator run health**
   - active run count
   - stalled run count
   - orchestrator error run count
2. **CI / PR / branch hygiene** (where available)
   - git branch cleanliness + ahead/behind sync
   - dependency marker status
   - CI + PR context from environment (e.g., GitHub Actions)
3. **Voice/system degraded reasons**
   - `router.status` (NVIDIA router)
   - `spark.status` (DGX/Spark + voice pipeline)

## Gateway method contract

Method: `ops.snapshot`

Params:

```json
{
  "stalledAfterMs": 120000
}
```

- `stalledAfterMs` is optional.
- If omitted, default is `120000` (2 minutes).
- The gateway clamps it to `30_000..1_800_000`.

Result shape (abridged):

```json
{
  "generatedAt": 1730000000000,
  "orchestrator": {
    "status": "healthy|degraded|down|unknown",
    "activeRuns": 0,
    "stalledRuns": 0,
    "errorRuns": 0,
    "stalledAfterMs": 120000,
    "active": [
      {
        "runId": "run-123",
        "sessionKey": "main",
        "startedAt": 1730000000000,
        "ageMs": 15234,
        "lastDeltaAt": 1730000009000,
        "idleMs": 6234,
        "stalled": false,
        "boardId": "main",
        "cardId": "card-1"
      }
    ],
    "links": [{ "label": "Open Orchestrator", "tab": "orchestrator" }]
  },
  "hygiene": {
    "status": "healthy|degraded|down|unknown",
    "installKind": "git|package|unknown",
    "packageManager": "pnpm|bun|npm|unknown",
    "git": {
      "branch": "feature/ops",
      "upstream": "origin/feature/ops",
      "dirty": false,
      "ahead": 0,
      "behind": 0,
      "fetchOk": null,
      "sha": "abc123"
    },
    "deps": { "status": "ok|missing|stale|unknown", "reason": "..." },
    "ci": {
      "detected": true,
      "provider": "github-actions",
      "workflow": "CI",
      "event": "pull_request",
      "branch": "feature/ops",
      "runId": "123",
      "runUrl": "https://github.com/.../actions/runs/123"
    },
    "pr": {
      "detected": true,
      "number": 42,
      "url": "https://github.com/.../pull/42",
      "baseRef": "main",
      "headRef": "feature/ops"
    },
    "checks": [
      { "id": "branch-clean", "label": "Branch clean", "status": "degraded", "detail": "..." }
    ]
  },
  "voiceSystem": {
    "status": "healthy|degraded|down|unknown",
    "degradedReasons": ["Spark voice pipeline is unavailable."],
    "router": {
      "enabled": true,
      "healthy": true,
      "url": "http://127.0.0.1:8001/health"
    },
    "spark": {
      "enabled": true,
      "active": true,
      "overall": "degraded",
      "voiceAvailable": false
    },
    "links": [{ "label": "DGX", "tab": "dgx" }]
  }
}
```

## Operator usage notes

- Use the panel on **Overview** for first-pass triage.
- Use drill-down buttons for deeper context:
  - **Open Orchestrator** for run/card details
  - **Open DGX** for Spark service state
  - **Open Debug** for raw method probing
- If snapshot data is unavailable, the panel keeps existing Overview behavior and
  displays an inline unavailable/error hint instead of breaking the page.
