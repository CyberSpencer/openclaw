---
summary: "Threat model and operator checklist for Skill/MCP trust-gate decisions"
read_when:
  - Reviewing a new skill/tool/MCP integration
  - Enabling strict trust-gate policy
title: "Skill/MCP Trust Gate"
---

# Skill/MCP Trust Gate

OpenClaw now evaluates trust signals before enabling and running skill-based integrations.
This gate is designed to reduce risky enablement of third-party skills, tool wrappers,
or MCP bridge workflows.

## Threat model (what this gate mitigates)

### 1) Excessive permission scope

**Threat:** A skill asks for broad permissions (`admin`, unrestricted exec) when narrower access would do.

**Mitigation:** `trust.permissionScope` is scored. Broad scopes lower the trust score and can be blocked in strict mode.

### 2) Unsafe token handling

**Threat:** Integrations persist API tokens insecurely or do not require redaction.

**Mitigation:** `trust.tokenHandling` / `trust.tokenPolicy` is scored (`persistent` is high-risk, missing redaction is penalized).

### 3) Unbounded network egress

**Threat:** Skills or MCP connectors can exfiltrate data to arbitrary hosts.

**Mitigation:** `trust.network` / `trust.networkTargets` is scored. `mode: "any"` is high-risk; allowlists score best.

### 4) Unknown provenance / supply chain risk

**Threat:** A skill has no publisher/source metadata, or cannot be traced to reviewed provenance.

**Mitigation:** `trust.provenance` is required for strong scores (source/publisher/signature/review metadata).

## Policy levels

Configured via `skills.trustGate.level`:

- `warn` (default): risky integrations are allowed but logged and flagged.
- `block`: high-risk integrations are blocked unless an explicit operator override is set.

Thresholds:

- `skills.trustGate.warnThreshold` (default 70)
- `skills.trustGate.blockThreshold` (default 45)

Audit log path:

- `skills.trustGate.auditLogPath` (default `~/.openclaw/audit/skill-trust-gate.jsonl`)

## Operator override path

When strict mode blocks a skill, override explicitly after review:

- Gateway/API: `skills.update` with
  `trustOverride: { approve: true, reason: "<review reason>", approvedBy: "<operator>" }`
- Config file equivalent:
  `skills.entries.<skillKey>.trustGateOverride = { reason, approvedAt, approvedBy? }`

> Overrides should be treated as change-controlled exceptions, not defaults.

## Review checklist (before override)

- [ ] Permission scope is least-privilege and justified.
- [ ] Token handling policy is documented and redaction is enforced.
- [ ] Network target constraints are explicit (prefer allowlist).
- [ ] Provenance metadata identifies source and publisher.
- [ ] Skill content has been manually reviewed for obvious credential exfiltration paths.
- [ ] Audit trail captures who approved and why.
- [ ] A rollback plan exists (disable skill / remove override).

## Backward-compatibility and rollout guidance

- Default policy is `warn` to avoid breaking existing installs.
- Start in `warn`, monitor audit logs, then promote to `block` when your metadata coverage is mature.
