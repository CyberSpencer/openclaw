import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig, SkillConfig } from "../../config/config.js";
import type { SkillEligibilityContext, SkillEntry } from "./types.js";
import { resolveSkillKey } from "./frontmatter.js";
import {
  evaluateSkillTrustGate,
  writeSkillTrustGateAudit,
  type SkillTrustGateFinding,
} from "./trust-gate.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

const trustGateAuditOnce = new Set<string>();

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

export function resolveConfigPath(config: OpenClawConfig | undefined, pathStr: string) {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (value === undefined && pathStr in DEFAULT_CONFIG_VALUES) {
    return DEFAULT_CONFIG_VALUES[pathStr];
  }
  return isTruthy(value);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

export function resolveRuntimePlatform(): string {
  return process.platform;
}

function normalizeAllowlist(input: unknown): string[] | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(entry.skill.source);
}

export function resolveBundledAllowlist(config?: OpenClawConfig): string[] | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.includes(key) || allowlist.includes(entry.skill.name);
}

export function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

function auditTrustGateDecision(params: {
  config?: OpenClawConfig;
  skillKey: string;
  entry: SkillEntry;
  score: number;
  decision: "allow" | "warn" | "block";
  effectiveDecision: "allow" | "warn" | "block";
  policyLevel: "warn" | "block";
  overridden: boolean;
  overrideRequired: boolean;
  findings: SkillTrustGateFinding[];
}) {
  if (params.effectiveDecision === "allow") {
    return;
  }
  const onceKey = [
    "run",
    params.skillKey,
    params.score,
    params.decision,
    params.effectiveDecision,
    params.policyLevel,
    params.overridden ? "1" : "0",
  ].join(":");
  if (trustGateAuditOnce.has(onceKey)) {
    return;
  }
  trustGateAuditOnce.add(onceKey);
  writeSkillTrustGateAudit({
    config: params.config,
    record: {
      ts: new Date().toISOString(),
      phase: "run",
      source: "skills.run",
      skillName: params.entry.skill.name,
      skillKey: params.skillKey,
      score: params.score,
      decision: params.decision,
      effectiveDecision: params.effectiveDecision,
      policyLevel: params.policyLevel,
      overridden: params.overridden,
      overrideRequired: params.overrideRequired,
      findings: params.findings,
    },
  });
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);
  const osList = entry.metadata?.os ?? [];
  const remotePlatforms = eligibility?.remote?.platforms ?? [];

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, allowBundled)) {
    return false;
  }
  if (
    osList.length > 0 &&
    !osList.includes(resolveRuntimePlatform()) &&
    !remotePlatforms.some((platform) => osList.includes(platform))
  ) {
    return false;
  }
  const always = entry.metadata?.always === true;

  if (!always) {
    const requiredBins = entry.metadata?.requires?.bins ?? [];
    if (requiredBins.length > 0) {
      for (const bin of requiredBins) {
        if (hasBinary(bin)) {
          continue;
        }
        if (eligibility?.remote?.hasBin?.(bin)) {
          continue;
        }
        return false;
      }
    }
    const requiredAnyBins = entry.metadata?.requires?.anyBins ?? [];
    if (requiredAnyBins.length > 0) {
      const anyFound =
        requiredAnyBins.some((bin) => hasBinary(bin)) ||
        eligibility?.remote?.hasAnyBin?.(requiredAnyBins);
      if (!anyFound) {
        return false;
      }
    }

    const requiredEnv = entry.metadata?.requires?.env ?? [];
    if (requiredEnv.length > 0) {
      for (const envName of requiredEnv) {
        if (process.env[envName]) {
          continue;
        }
        if (skillConfig?.env?.[envName]) {
          continue;
        }
        if (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName) {
          continue;
        }
        return false;
      }
    }

    const requiredConfig = entry.metadata?.requires?.config ?? [];
    if (requiredConfig.length > 0) {
      for (const configPath of requiredConfig) {
        if (!isConfigPathTruthy(config, configPath)) {
          return false;
        }
      }
    }
  }

  const trustEvaluation = evaluateSkillTrustGate({
    entry,
    config,
    override: skillConfig?.trustGateOverride,
  });
  auditTrustGateDecision({
    config,
    skillKey,
    entry,
    score: trustEvaluation.score,
    decision: trustEvaluation.decision,
    effectiveDecision: trustEvaluation.effectiveDecision,
    policyLevel: trustEvaluation.policyLevel,
    overridden: trustEvaluation.overridden,
    overrideRequired: trustEvaluation.overrideRequired,
    findings: trustEvaluation.findings,
  });
  if (trustEvaluation.effectiveDecision === "block") {
    return false;
  }

  return true;
}
