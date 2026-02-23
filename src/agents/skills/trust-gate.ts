import fs from "node:fs";
import path from "node:path";
import type {
  OpenClawConfig,
  SkillTrustGateOverrideConfig,
  SkillsTrustGateConfig,
} from "../../config/config.js";
import type { SkillEntry, SkillTrustMetadata } from "./types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";

export type SkillTrustGatePhase = "enable" | "run";
export type SkillTrustGateDecision = "allow" | "warn" | "block";
export type SkillTrustGateSeverity = "info" | "warn" | "critical";
export type SkillTrustGateCategory =
  | "permissionScope"
  | "tokenHandlingPolicy"
  | "networkTargetConstraints"
  | "provenanceMetadata";

export type SkillTrustGateFinding = {
  category: SkillTrustGateCategory;
  severity: SkillTrustGateSeverity;
  message: string;
  penalty: number;
};

export type ResolvedSkillsTrustGatePolicy = {
  level: "warn" | "block";
  warnThreshold: number;
  blockThreshold: number;
  auditLogPath: string;
};

export type SkillTrustGateEvaluation = {
  score: number;
  decision: SkillTrustGateDecision;
  effectiveDecision: SkillTrustGateDecision;
  policyLevel: "warn" | "block";
  overridden: boolean;
  overrideRequired: boolean;
  findings: SkillTrustGateFinding[];
  summary: string;
};

export type SkillTrustGateAuditRecord = {
  ts: string;
  phase: SkillTrustGatePhase;
  source: "skills.update" | "skills.run";
  skillName: string;
  skillKey: string;
  score: number;
  decision: SkillTrustGateDecision;
  effectiveDecision: SkillTrustGateDecision;
  policyLevel: "warn" | "block";
  overridden: boolean;
  overrideRequired: boolean;
  findings: SkillTrustGateFinding[];
};

const DEFAULT_WARN_THRESHOLD = 70;
const DEFAULT_BLOCK_THRESHOLD = 45;
const DEFAULT_AUDIT_LOG_PATH = path.join(CONFIG_DIR, "audit", "skill-trust-gate.jsonl");

function normalizeThreshold(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(input)));
}

function resolveAuditPath(input?: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) {
    return DEFAULT_AUDIT_LOG_PATH;
  }
  const expanded = resolveUserPath(trimmed);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.join(CONFIG_DIR, expanded);
}

export function resolveSkillsTrustGatePolicy(
  config?: OpenClawConfig,
  overrides?: SkillsTrustGateConfig,
): ResolvedSkillsTrustGatePolicy {
  const raw = overrides ?? config?.skills?.trustGate;
  const level = raw?.level === "block" ? "block" : "warn";
  const warnThreshold = normalizeThreshold(raw?.warnThreshold, DEFAULT_WARN_THRESHOLD);
  const blockThreshold = normalizeThreshold(raw?.blockThreshold, DEFAULT_BLOCK_THRESHOLD);
  const normalizedBlockThreshold = Math.min(blockThreshold, warnThreshold);
  return {
    level,
    warnThreshold,
    blockThreshold: normalizedBlockThreshold,
    auditLogPath: resolveAuditPath(raw?.auditLogPath),
  };
}

function pushFinding(
  findings: SkillTrustGateFinding[],
  finding: SkillTrustGateFinding,
  score: { value: number },
) {
  findings.push(finding);
  score.value -= finding.penalty;
}

function evaluatePermissionScope(
  trust: SkillTrustMetadata | undefined,
  findings: SkillTrustGateFinding[],
  score: { value: number },
) {
  const scope =
    trust?.permissionScope?.map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  if (scope.length === 0) {
    pushFinding(
      findings,
      {
        category: "permissionScope",
        severity: "warn",
        message: "permission scope metadata missing",
        penalty: 20,
      },
      score,
    );
    return;
  }

  if (scope.includes("admin") || scope.includes("*") || scope.includes("all")) {
    pushFinding(
      findings,
      {
        category: "permissionScope",
        severity: "critical",
        message: "permission scope is broad (admin/all)",
        penalty: 35,
      },
      score,
    );
    return;
  }

  if (scope.includes("exec") || scope.includes("shell")) {
    pushFinding(
      findings,
      {
        category: "permissionScope",
        severity: "warn",
        message: "permission scope includes command execution",
        penalty: 18,
      },
      score,
    );
    return;
  }

  if (scope.includes("write") || scope.includes("modify")) {
    pushFinding(
      findings,
      {
        category: "permissionScope",
        severity: "warn",
        message: "permission scope includes write access",
        penalty: 10,
      },
      score,
    );
    return;
  }

  pushFinding(
    findings,
    {
      category: "permissionScope",
      severity: "info",
      message: "permission scope is declared and appears limited",
      penalty: 0,
    },
    score,
  );
}

function evaluateTokenHandlingPolicy(
  trust: SkillTrustMetadata | undefined,
  findings: SkillTrustGateFinding[],
  score: { value: number },
) {
  const token = trust?.tokenHandling;
  const policy = token?.policy;
  if (!token || !policy) {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "warn",
        message: "token handling policy metadata missing",
        penalty: 20,
      },
      score,
    );
    return;
  }

  if (policy === "persistent") {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "critical",
        message: "token policy allows persistent token storage",
        penalty: 25,
      },
      score,
    );
  } else if (policy === "scoped") {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "info",
        message: "token policy is scoped",
        penalty: 4,
      },
      score,
    );
  } else if (policy === "ephemeral" || policy === "none") {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "info",
        message: "token policy is least-privilege",
        penalty: 0,
      },
      score,
    );
  } else {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "warn",
        message: "unknown token policy, treating as potentially risky",
        penalty: 10,
      },
      score,
    );
  }

  if (policy !== "none" && token.redactionRequired !== true) {
    pushFinding(
      findings,
      {
        category: "tokenHandlingPolicy",
        severity: "warn",
        message: "token redaction requirement is not explicitly set",
        penalty: 8,
      },
      score,
    );
  }
}

function evaluateNetworkTargetConstraints(
  trust: SkillTrustMetadata | undefined,
  findings: SkillTrustGateFinding[],
  score: { value: number },
) {
  const network = trust?.network;
  const mode = network?.mode;
  if (!network || !mode) {
    pushFinding(
      findings,
      {
        category: "networkTargetConstraints",
        severity: "warn",
        message: "network target constraints metadata missing",
        penalty: 20,
      },
      score,
    );
    return;
  }

  if (mode === "any") {
    pushFinding(
      findings,
      {
        category: "networkTargetConstraints",
        severity: "critical",
        message: "network policy allows any outbound target",
        penalty: 30,
      },
      score,
    );
    return;
  }

  if (mode === "allowlist") {
    const targets = network.targets ?? [];
    if (targets.length === 0) {
      pushFinding(
        findings,
        {
          category: "networkTargetConstraints",
          severity: "warn",
          message: "network allowlist mode is set but targets are missing",
          penalty: 20,
        },
        score,
      );
      return;
    }
    pushFinding(
      findings,
      {
        category: "networkTargetConstraints",
        severity: "info",
        message: `network allowlist declared (${targets.length} target${targets.length === 1 ? "" : "s"})`,
        penalty: 3,
      },
      score,
    );
    return;
  }

  if (mode === "restricted") {
    pushFinding(
      findings,
      {
        category: "networkTargetConstraints",
        severity: "warn",
        message: "network policy is restricted but not allowlisted",
        penalty: 10,
      },
      score,
    );
    return;
  }

  pushFinding(
    findings,
    {
      category: "networkTargetConstraints",
      severity: "info",
      message: "network policy is disabled (none)",
      penalty: 0,
    },
    score,
  );
}

function evaluateProvenanceMetadata(
  trust: SkillTrustMetadata | undefined,
  findings: SkillTrustGateFinding[],
  score: { value: number },
) {
  const provenance = trust?.provenance;
  if (!provenance) {
    pushFinding(
      findings,
      {
        category: "provenanceMetadata",
        severity: "warn",
        message: "provenance metadata missing",
        penalty: 25,
      },
      score,
    );
    return;
  }

  if (!provenance.source?.trim()) {
    pushFinding(
      findings,
      {
        category: "provenanceMetadata",
        severity: "warn",
        message: "provenance source is missing",
        penalty: 12,
      },
      score,
    );
  }

  if (!provenance.publisher?.trim()) {
    pushFinding(
      findings,
      {
        category: "provenanceMetadata",
        severity: "warn",
        message: "provenance publisher is missing",
        penalty: 12,
      },
      score,
    );
  }

  if (provenance.signature === "verified") {
    score.value += 5;
    findings.push({
      category: "provenanceMetadata",
      severity: "info",
      message: "provenance signature is verified",
      penalty: 0,
    });
    return;
  }

  if (provenance.signature === "unsigned") {
    pushFinding(
      findings,
      {
        category: "provenanceMetadata",
        severity: "warn",
        message: "provenance signature is unsigned",
        penalty: 10,
      },
      score,
    );
  }
}

function resolveDecision(
  score: number,
  policy: ResolvedSkillsTrustGatePolicy,
): SkillTrustGateDecision {
  if (score < policy.blockThreshold) {
    return "block";
  }
  if (score < policy.warnThreshold) {
    return "warn";
  }
  return "allow";
}

function hasUsableOverride(override?: SkillTrustGateOverrideConfig): boolean {
  if (!override) {
    return false;
  }
  if (!override.reason?.trim()) {
    return false;
  }
  if (!override.approvedAt?.trim()) {
    return false;
  }
  return true;
}

export function evaluateSkillTrustGate(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  policy?: SkillsTrustGateConfig;
  override?: SkillTrustGateOverrideConfig;
}): SkillTrustGateEvaluation {
  const policy = resolveSkillsTrustGatePolicy(params.config, params.policy);
  const findings: SkillTrustGateFinding[] = [];
  const score = { value: 100 };
  const trust = params.entry.metadata?.trust;

  evaluatePermissionScope(trust, findings, score);
  evaluateTokenHandlingPolicy(trust, findings, score);
  evaluateNetworkTargetConstraints(trust, findings, score);
  evaluateProvenanceMetadata(trust, findings, score);

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score.value)));
  const decision = resolveDecision(normalizedScore, policy);

  let effectiveDecision: SkillTrustGateDecision = decision;
  if (policy.level === "warn" && decision === "block") {
    effectiveDecision = "warn";
  }

  let overridden = false;
  if (effectiveDecision === "block" && hasUsableOverride(params.override)) {
    overridden = true;
    effectiveDecision = "warn";
  }

  const overrideRequired = effectiveDecision === "block";
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warn = findings.filter((finding) => finding.severity === "warn").length;

  return {
    score: normalizedScore,
    decision,
    effectiveDecision,
    policyLevel: policy.level,
    overridden,
    overrideRequired,
    findings,
    summary: `score=${normalizedScore} decision=${decision} effective=${effectiveDecision} critical=${critical} warn=${warn}`,
  };
}

export function writeSkillTrustGateAudit(params: {
  config?: OpenClawConfig;
  policy?: SkillsTrustGateConfig;
  record: SkillTrustGateAuditRecord;
}): void {
  const policy = resolveSkillsTrustGatePolicy(params.config, params.policy);
  void fs.promises
    .mkdir(path.dirname(policy.auditLogPath), { recursive: true })
    .then(() =>
      fs.promises.appendFile(policy.auditLogPath, `${JSON.stringify(params.record)}\n`, "utf8"),
    )
    .catch(() => {
      // Never block execution on audit log write failures.
    });
}
