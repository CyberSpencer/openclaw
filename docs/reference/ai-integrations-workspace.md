---
summary: "AI Integrations private workspace repo and DGX Spark integration notes (private mirror)"
read_when:
  - Working on OpenClaw inside AI Integrations
  - Understanding how the private ops repo relates to core
---

# AI Integrations workspace + OpenClaw core (private)

This repository (`AI-Integrations/openclaw-core`) is a **private mirror** of the public OSS repo `openclaw/openclaw`.

AI Integrations maintains a separate **workspace/ops repo** that documents how we run OpenClaw locally and how we integrate optional LAN compute backends.

## Related repos

- **OpenClaw upstream (public OSS):** https://github.com/openclaw/openclaw
- **OpenClaw core private mirror (this repo):** https://github.com/AI-Integrations/openclaw-core
- **Jarvis workspace / ops repo (private):** https://github.com/AI-Integrations/jarvis-moltbot-spencer

## How they fit together

- `openclaw-core` is the actual product runtime/source (gateway, tools, Control UI, etc.).
- `jarvis-moltbot-spencer` is the private workspace:
  - operational scripts (start/stop/status, health gates)
  - environment contracts and runbooks
  - private deployment documentation
  - DGX Spark integration guide

Locally, AI Integrations typically clones `openclaw-core` into the workspace at:

- `/Users/spencerthomson/clawd/core`

That `core/` directory is **gitignored** by the workspace repo.

## DGX Spark integration (optional)

AI Integrations can run an optional DGX Spark host as a **LAN compute backend** (Ollama, router hint service, embeddings, qdrant, PersonaPlex).

Canonical Mac-side documentation lives in the workspace repo:

- https://github.com/AI-Integrations/jarvis-moltbot-spencer/blob/main/docs/spark-integration.md

Key invariant:

- The Mac control plane remains functional if Spark is down.
