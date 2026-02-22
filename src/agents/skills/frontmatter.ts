import type { Skill } from "@mariozechner/pi-coding-agent";
import JSON5 from "json5";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
  SkillTrustMetadata,
} from "./types.js";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../../compat/legacy-names.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import { parseBooleanValue } from "../../utils/boolean.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function normalizeStringList(input: unknown): string[] {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "brew" && kind !== "node" && kind !== "go" && kind !== "uv" && kind !== "download") {
    return undefined;
  }

  const spec: SkillInstallSpec = {
    kind: kind,
  };

  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  if (typeof raw.formula === "string") {
    spec.formula = raw.formula;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  return spec;
}

function parseTrustMetadata(input: unknown): SkillTrustMetadata | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;

  const permissionScope = normalizeStringList(raw.permissionScope ?? raw.permissions);

  const tokenRaw =
    raw.tokenHandling && typeof raw.tokenHandling === "object"
      ? (raw.tokenHandling as Record<string, unknown>)
      : raw.tokenPolicy && typeof raw.tokenPolicy === "object"
        ? (raw.tokenPolicy as Record<string, unknown>)
        : undefined;
  const tokenPolicyRaw =
    typeof tokenRaw?.policy === "string"
      ? tokenRaw.policy
      : typeof tokenRaw?.mode === "string"
        ? tokenRaw.mode
        : "";
  const tokenPolicy = tokenPolicyRaw.trim().toLowerCase();
  const normalizedTokenPolicy =
    tokenPolicy === "none" ||
    tokenPolicy === "ephemeral" ||
    tokenPolicy === "scoped" ||
    tokenPolicy === "persistent"
      ? tokenPolicy
      : undefined;

  const networkRaw =
    raw.network && typeof raw.network === "object"
      ? (raw.network as Record<string, unknown>)
      : raw.networkTargets && typeof raw.networkTargets === "object"
        ? (raw.networkTargets as Record<string, unknown>)
        : undefined;
  const networkModeRaw =
    typeof networkRaw?.mode === "string"
      ? networkRaw.mode
      : typeof networkRaw?.policy === "string"
        ? networkRaw.policy
        : "";
  const networkMode = networkModeRaw.trim().toLowerCase();
  const normalizedNetworkMode =
    networkMode === "none" ||
    networkMode === "allowlist" ||
    networkMode === "restricted" ||
    networkMode === "any"
      ? networkMode
      : undefined;
  const networkTargets = normalizeStringList(networkRaw?.targets ?? networkRaw?.allow);

  const provenanceRaw =
    raw.provenance && typeof raw.provenance === "object"
      ? (raw.provenance as Record<string, unknown>)
      : undefined;
  const signatureRaw =
    typeof provenanceRaw?.signature === "string"
      ? provenanceRaw.signature.trim().toLowerCase()
      : "";
  const normalizedSignature =
    signatureRaw === "verified" || signatureRaw === "unsigned" || signatureRaw === "unknown"
      ? signatureRaw
      : undefined;

  const trust: SkillTrustMetadata = {
    permissionScope: permissionScope.length > 0 ? permissionScope : undefined,
    tokenHandling: tokenRaw
      ? {
          policy: normalizedTokenPolicy,
          redactionRequired:
            typeof tokenRaw.redactionRequired === "boolean"
              ? tokenRaw.redactionRequired
              : undefined,
          rotationRequired:
            typeof tokenRaw.rotationRequired === "boolean" ? tokenRaw.rotationRequired : undefined,
        }
      : undefined,
    network: networkRaw
      ? {
          mode: normalizedNetworkMode,
          targets: networkTargets.length > 0 ? networkTargets : undefined,
        }
      : undefined,
    provenance: provenanceRaw
      ? {
          source: typeof provenanceRaw.source === "string" ? provenanceRaw.source : undefined,
          publisher:
            typeof provenanceRaw.publisher === "string" ? provenanceRaw.publisher : undefined,
          signature: normalizedSignature,
          reviewedAt:
            typeof provenanceRaw.reviewedAt === "string" ? provenanceRaw.reviewedAt : undefined,
          reviewedBy:
            typeof provenanceRaw.reviewedBy === "string" ? provenanceRaw.reviewedBy : undefined,
        }
      : undefined,
  };

  const hasValues =
    Boolean(trust.permissionScope?.length) ||
    Boolean(trust.tokenHandling) ||
    Boolean(trust.network) ||
    Boolean(trust.provenance);
  return hasValues ? trust : undefined;
}

function getFrontmatterValue(frontmatter: ParsedSkillFrontmatter, key: string): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

export function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const raw = getFrontmatterValue(frontmatter, "metadata");
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const metadataRawCandidates = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
    let metadataRaw: unknown;
    for (const key of metadataRawCandidates) {
      const candidate = parsed[key];
      if (candidate && typeof candidate === "object") {
        metadataRaw = candidate;
        break;
      }
    }
    if (!metadataRaw || typeof metadataRaw !== "object") {
      return undefined;
    }
    const metadataObj = metadataRaw as Record<string, unknown>;
    const requiresRaw =
      typeof metadataObj.requires === "object" && metadataObj.requires !== null
        ? (metadataObj.requires as Record<string, unknown>)
        : undefined;
    const installRaw = Array.isArray(metadataObj.install) ? (metadataObj.install as unknown[]) : [];
    const install = installRaw
      .map((entry) => parseInstallSpec(entry))
      .filter((entry): entry is SkillInstallSpec => Boolean(entry));
    const osRaw = normalizeStringList(metadataObj.os);
    const trust = parseTrustMetadata(metadataObj.trust);
    return {
      always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
      emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
      homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
      skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
      primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
      os: osRaw.length > 0 ? osRaw : undefined,
      requires: requiresRaw
        ? {
            bins: normalizeStringList(requiresRaw.bins),
            anyBins: normalizeStringList(requiresRaw.anyBins),
            env: normalizeStringList(requiresRaw.env),
            config: normalizeStringList(requiresRaw.config),
          }
        : undefined,
      install: install.length > 0 ? install : undefined,
      trust,
    };
  } catch {
    return undefined;
  }
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterValue(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterValue(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
