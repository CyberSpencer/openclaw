import type { OpenClawConfig, SkillTrustGateOverrideConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import {
  evaluateSkillTrustGate,
  loadWorkspaceSkillEntries,
  writeSkillTrustGateAudit,
  type SkillEntry,
} from "../../agents/skills.js";
import { resolveSkillKey } from "../../agents/skills/frontmatter.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";

function listWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

function findSkillEntryByKey(entries: SkillEntry[], skillKey: string): SkillEntry | undefined {
  const normalized = skillKey.trim();
  if (!normalized) {
    return undefined;
  }
  return entries.find((entry) => {
    const key = resolveSkillKey(entry.skill, entry);
    return key === normalized || entry.skill.name === normalized;
  });
}

function buildOverrideFromParams(
  input: unknown,
  current: SkillTrustGateOverrideConfig | undefined,
): SkillTrustGateOverrideConfig | undefined {
  if (!input || typeof input !== "object") {
    return current;
  }
  const raw = input as Record<string, unknown>;
  const approve = raw.approve;
  if (approve === false) {
    return undefined;
  }
  if (approve !== true) {
    return current;
  }

  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) {
    return current;
  }
  const approvedByRaw = typeof raw.approvedBy === "string" ? raw.approvedBy.trim() : "";

  return {
    reason,
    approvedAt: new Date().toISOString(),
    approvedBy: approvedByRaw || undefined,
  };
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
      trustOverride?: {
        approve?: boolean;
        reason?: string;
        approvedBy?: string;
      };
    };
    if (
      p.trustOverride?.approve === true &&
      (typeof p.trustOverride.reason !== "string" || !p.trustOverride.reason.trim())
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "trustOverride.reason is required when trustOverride.approve=true",
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};

    const nextOverride = buildOverrideFromParams(p.trustOverride, current.trustGateOverride);
    if (nextOverride) {
      current.trustGateOverride = nextOverride;
    } else if (p.trustOverride?.approve === false) {
      delete current.trustGateOverride;
    }

    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }

    const willBeEnabled = current.enabled !== false;
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const workspaceEntries = loadWorkspaceSkillEntries(workspaceDirRaw, { config: cfg });
    const skillEntry = findSkillEntryByKey(workspaceEntries, p.skillKey);
    const trustGate =
      skillEntry && willBeEnabled
        ? evaluateSkillTrustGate({
            entry: skillEntry,
            config: cfg,
            override: current.trustGateOverride,
          })
        : undefined;

    if (skillEntry && trustGate) {
      writeSkillTrustGateAudit({
        config: cfg,
        record: {
          ts: new Date().toISOString(),
          phase: "enable",
          source: "skills.update",
          skillName: skillEntry.skill.name,
          skillKey: p.skillKey,
          score: trustGate.score,
          decision: trustGate.decision,
          effectiveDecision: trustGate.effectiveDecision,
          policyLevel: trustGate.policyLevel,
          overridden: trustGate.overridden,
          overrideRequired: trustGate.overrideRequired,
          findings: trustGate.findings,
        },
      });

      if (trustGate.effectiveDecision === "block") {
        respond(
          false,
          {
            ok: false,
            skillKey: p.skillKey,
            trustGate,
          },
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Trust gate blocked skill "${p.skillKey}" (score ${trustGate.score}). Override with skills.update { trustOverride: { approve: true, reason: "<operator review>", approvedBy: "<you>" } } after review.`,
          ),
        );
        return;
      }
    }

    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: OpenClawConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current, trustGate }, undefined);
  },
};
