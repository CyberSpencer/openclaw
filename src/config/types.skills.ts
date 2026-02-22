export type SkillTrustGatePolicyLevel = "warn" | "block";

export type SkillTrustGateOverrideConfig = {
  /** Human-entered justification for allowing a blocked integration. */
  reason: string;
  /** ISO timestamp when the override was approved. */
  approvedAt: string;
  /** Optional operator identity (user/email/id). */
  approvedBy?: string;
};

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  /** Manual operator override for trust-gate block decisions. */
  trustGateOverride?: SkillTrustGateOverrideConfig;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

export type SkillsTrustGateConfig = {
  /**
   * warn (default): risky integrations are allowed but surfaced as warnings.
   * block: high-risk integrations are blocked unless operator override is set.
   */
  level?: SkillTrustGatePolicyLevel;
  /**
   * Score < warnThreshold yields warn (or block in strict mode if also below blockThreshold).
   */
  warnThreshold?: number;
  /**
   * Score < blockThreshold yields block when level="block".
   */
  blockThreshold?: number;
  /** Optional JSONL audit path for trust-gate decisions. */
  auditLogPath?: string;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  trustGate?: SkillsTrustGateConfig;
  entries?: Record<string, SkillConfig>;
};
