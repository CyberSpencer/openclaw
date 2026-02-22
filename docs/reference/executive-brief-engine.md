---
summary: "Unified executive brief payload from sessions, usage, orchestrator, cron, and messaging health"
---

# Executive brief engine

The gateway exposes a unified executive briefing method:

- **Method:** `brief.get`
- **Scope:** read-only (`operator.read`)
- **Sources:** sessions, usage, orchestrator state, cron status, messaging runtime
- **Behavior:** graceful degradation (partial/unavailable sources are surfaced in `warnings` and `degraded`)

## Request

```json
{
  "preset": "am",
  "windows": {
    "sessionsMinutes": 720,
    "usageMinutes": 1440,
    "orchestratorMinutes": 1440,
    "cronMinutes": 720,
    "messagingMinutes": 720
  },
  "topActionsLimit": 3
}
```

### Params

- `preset` (optional): `"am" | "pm"`
  - `am` defaults: longer lookback windows
  - `pm` defaults: shorter lookback windows
- `windows` (optional): override source windows (5..10080 minutes each)
- `topActionsLimit` (optional): 1..5, default `3`

## Response

```json
{
  "generatedAt": 1771777777000,
  "preset": "am",
  "windows": {
    "sessionsMinutes": 720,
    "usageMinutes": 1440,
    "orchestratorMinutes": 1440,
    "cronMinutes": 720,
    "messagingMinutes": 720
  },
  "degraded": false,
  "warnings": [],
  "topActions": [
    {
      "id": "messaging-errors",
      "title": "Stabilize messaging channel health",
      "rationale": "2 account(s) report connection/auth errors. Resolve before inbound messages queue up.",
      "confidence": 0.9,
      "score": 91,
      "source": "messaging"
    }
  ],
  "sources": {
    "sessions": {
      "status": "ok",
      "warnings": [],
      "totalSessions": 18,
      "activeSessions": 6,
      "staleSessions": 12,
      "latestUpdatedAt": 1771777000000
    },
    "usage": {
      "status": "ok",
      "warnings": [],
      "totals": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "totalCost": 0,
        "inputCost": 0,
        "outputCost": 0,
        "cacheReadCost": 0,
        "cacheWriteCost": 0,
        "missingCostEntries": 0
      },
      "activeAgents": 1,
      "dailyEntries": 7
    }
  }
}
```

## Notes

- `topActions` is ranked by severity + source confidence.
- `confidence` is per-action confidence in the recommendation, not model certainty.
- If one or more sources are degraded, the brief remains usable and includes a telemetry-recovery action when relevant.
