import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue, toAgentModelListLike } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { normalizeGoogleModelId } from "./models-config.providers.js";

const log = createSubsystemLogger("model-selection");

export type ModelRef = {
  provider: string;
  model: string;
};

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
};
const OPENAI_CODEX_OAUTH_MODEL_PREFIXES = ["gpt-5.3-codex"] as const;

// ---------------------------------------------------------------------------
// Anthropic routing lanes
// ---------------------------------------------------------------------------

/**
 * Model-level routing lanes for Anthropic provider.
 *
 * Sonnet  = standard/general purpose
 * Haiku   = fast utility tasks (cheap, low-latency)
 * Nemotron= private/local cheap default (DGX Spark / Ollama)
 * Opus    = selective premium (complex reasoning tasks)
 */
export type AnthropicModelLane =
  | "anthropic-sonnet"
  | "anthropic-haiku"
  | "anthropic-nemotron"
  | "anthropic-opus";

/**
 * Fallback model used when Sonnet is rate-limited.
 * Routes to the local Spark/Ollama Nemotron instance.
 */
export const ANTHROPIC_RATE_LIMIT_FALLBACK_MODEL = "ollama/nemotron-3-nano:30b";

/** Classify an anthropic model string into a routing lane. */
export function resolveAnthropicLane(modelRef: string): AnthropicModelLane | null {
  const lower = modelRef.toLowerCase();
  if (!lower.includes("claude") && !lower.includes("anthropic")) {
    return null;
  }
  if (lower.includes("haiku")) {
    return "anthropic-haiku";
  }
  if (lower.includes("opus")) {
    return "anthropic-opus";
  }
  if (lower.includes("nemotron") || lower.includes("nano")) {
    return "anthropic-nemotron";
  }
  if (lower.includes("sonnet") || lower.includes("claude")) {
    return "anthropic-sonnet";
  }
  return null;
}

/**
 * Check whether a specific Anthropic model ref is currently suppressed
 * (rate-limited) by reading the router suppression state file.
 *
 * Returns `true` if the model has an active suppression entry.
 * Fails silently — returns `false` on any IO/parse error.
 */
export function isAnthropicModelSuppressed(modelRef: string, now?: number): boolean {
  const ts = now ?? Date.now();
  try {
    const runtimeRoot = process.env.OPENCLAW_RUNTIME_DIR?.trim() || join(homedir(), ".openclaw");
    const suppressionPath = join(runtimeRoot, "tmp", "router-anthropic-suppression.json");
    if (!existsSync(suppressionPath)) {
      return false;
    }
    const payload = JSON.parse(readFileSync(suppressionPath, "utf8")) as {
      blanket?: { suppressed_until?: number; reason?: string } | null;
      per_model?: Record<string, { suppressed_until?: number; reason?: string }>;
    };
    // Check blanket suppression first
    const blanket = payload?.blanket;
    if (blanket && typeof blanket.suppressed_until === "number") {
      if (blanket.suppressed_until * 1000 > ts) {
        return true;
      }
    }
    // Check per-model suppression
    const perModel = payload?.per_model;
    if (perModel && typeof perModel === "object") {
      const entry = perModel[modelRef.trim()];
      if (entry && typeof entry.suppressed_until === "number") {
        if (entry.suppressed_until * 1000 > ts) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function modelKey(provider: string, model: string) {
  return `${provider}/${model}`;
}

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "qwen") {
    return "qwen-portal";
  }
  if (normalized === "kimi-code") {
    return "kimi-coding";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  // Backward compatibility for older provider naming.
  if (normalized === "bytedance" || normalized === "doubao") {
    return "volcengine";
  }
  return normalized;
}

export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(entries)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  if (normalized === "claude-cli") {
    return true;
  }
  if (normalized === "codex-cli") {
    return true;
  }
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}

function normalizeAnthropicModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  return ANTHROPIC_MODEL_ALIASES[lower] ?? trimmed;
}

function normalizeProviderModelId(provider: string, model: string): string {
  if (provider === "anthropic") {
    return normalizeAnthropicModelId(model);
  }
  if (provider === "vercel-ai-gateway" && !model.includes("/")) {
    // Allow Vercel-specific Claude refs without an upstream prefix.
    const normalizedAnthropicModel = normalizeAnthropicModelId(model);
    if (normalizedAnthropicModel.startsWith("claude-")) {
      return `anthropic/${normalizedAnthropicModel}`;
    }
  }
  if (provider === "google") {
    return normalizeGoogleModelId(model);
  }
  // OpenRouter-native models (e.g. "openrouter/aurora-alpha") need the full
  // "openrouter/<name>" as the model ID sent to the API. Models from external
  // providers already contain a slash (e.g. "anthropic/claude-sonnet-4-5") and
  // are passed through as-is (#12924).
  if (provider === "openrouter" && !model.includes("/")) {
    return `openrouter/${model}`;
  }
  return model;
}

function shouldUseOpenAICodexProvider(provider: string, model: string): boolean {
  if (provider !== "openai") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return OPENAI_CODEX_OAUTH_MODEL_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`),
  );
}

export function normalizeModelRef(provider: string, model: string): ModelRef {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim());
  if (shouldUseOpenAICodexProvider(normalizedProvider, normalizedModel)) {
    return { provider: "openai-codex", model: normalizedModel };
  }
  return { provider: normalizedProvider, model: normalizedModel };
}

export function parseModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return normalizeModelRef(defaultProvider, trimmed);
  }
  const providerRaw = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !model) {
    return null;
  }
  return normalizeModelRef(providerRaw, model);
}

export function inferUniqueProviderFromConfiguredModels(params: {
  cfg: OpenClawConfig;
  model: string;
}): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const configuredModels = params.cfg.agents?.defaults?.models;
  if (!configuredModels) {
    return undefined;
  }
  const normalized = model.toLowerCase();
  const providers = new Set<string>();
  for (const key of Object.keys(configuredModels)) {
    const ref = key.trim();
    if (!ref || !ref.includes("/")) {
      continue;
    }
    const parsed = parseModelRef(ref, DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    if (parsed.model === model || parsed.model.toLowerCase() === normalized) {
      providers.add(parsed.provider);
      if (providers.size > 1) {
        return undefined;
      }
    }
  }
  if (providers.size !== 1) {
    return undefined;
  }
  return providers.values().next().value;
}

export function resolveAllowlistModelKey(raw: string, defaultProvider: string): string | null {
  const parsed = parseModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

export function buildConfiguredAllowlistKeys(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
}): Set<string> | null {
  const rawAllowlist = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
  if (rawAllowlist.length === 0) {
    return null;
  }

  const keys = new Set<string>();
  for (const raw of rawAllowlist) {
    const key = resolveAllowlistModelKey(String(raw ?? ""), params.defaultProvider);
    if (key) {
      keys.add(key);
    }
  }
  return keys.size > 0 ? keys : null;
}

export function buildModelAliasIndex(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();

  const rawModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const parsed = parseModelRef(String(keyRaw ?? ""), params.defaultProvider);
    if (!parsed) {
      continue;
    }
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    const aliasKey = normalizeAliasKey(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byKey };
}

export function resolveModelRefFromString(params: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
}): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  if (!model.includes("/")) {
    const aliasKey = normalizeAliasKey(model);
    const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
    if (aliasMatch) {
      return { ref: aliasMatch.ref, alias: aliasMatch.alias };
    }
  }
  const parsed = parseModelRef(model, params.defaultProvider);
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

export function resolveConfiguredModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
}): ModelRef {
  const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
    });
    if (!trimmed.includes("/")) {
      const aliasKey = normalizeAliasKey(trimmed);
      const aliasMatch = aliasIndex.byAlias.get(aliasKey);
      if (aliasMatch) {
        return aliasMatch.ref;
      }

      // Default to anthropic if no provider is specified, but warn as this is deprecated.
      log.warn(
        `Model "${trimmed}" specified without provider. Falling back to "anthropic/${trimmed}". Please use "anthropic/${trimmed}" in your config.`,
      );
      return { provider: "anthropic", model: trimmed };
    }

    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      return resolved.ref;
    }
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

export function resolveDefaultModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  const agentModelOverride = params.agentId
    ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
    : undefined;
  const cfg =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...params.cfg.agents?.defaults,
              model: {
                ...toAgentModelListLike(params.cfg.agents?.defaults?.model),
                primary: agentModelOverride,
              },
            },
          },
        }
      : params.cfg;
  return resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

export type SubagentModelRoute =
  | "explicit"
  | "simple-kimi"
  | "configured-default"
  | AnthropicModelLane;

export type SubagentSpawnModelSelection = {
  model: string;
  route: SubagentModelRoute;
  /** Set to true when model was substituted due to rate-limit suppression. */
  rateLimitFallback?: boolean;
};

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(agentConfig?.model)
  );
}

export function resolveSubagentSpawnModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelOverride?: unknown;
  now?: number;
}): SubagentSpawnModelSelection {
  const now = params.now ?? Date.now();
  const runtimeDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const resolvedOverride = normalizeModelSelection(params.modelOverride);
  if (resolvedOverride) {
    return {
      model: resolvedOverride,
      route: "explicit",
    };
  }

  const configuredModel = resolveSubagentConfiguredModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });

  const candidateModel =
    configuredModel ??
    normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ??
    `${runtimeDefault.provider}/${runtimeDefault.model}`;

  return resolveAnthropicAwareSelection(candidateModel, "configured-default", now);
}

/**
 * Resolve the final model + route for a given candidate model string.
 *
 * If the candidate is an Anthropic Sonnet model and it is currently
 * rate-limited (suppressed), transparently substitutes the local
 * Nemotron/Spark fallback model instead of hammering the Anthropic API.
 *
 * For all other Anthropic models, attaches the appropriate lane tag so
 * telemetry and the UI can show which tier was used.
 */
function resolveAnthropicAwareSelection(
  candidateModel: string,
  baseRoute: SubagentModelRoute,
  now: number,
): SubagentSpawnModelSelection {
  const anthropicLane = resolveAnthropicLane(candidateModel);
  if (!anthropicLane) {
    // Not an Anthropic model — return as-is with the base route.
    return { model: candidateModel, route: baseRoute };
  }

  // Sonnet rate-limit cooldown routing: swap to local Nemotron/Spark when suppressed.
  if (anthropicLane === "anthropic-sonnet" && isAnthropicModelSuppressed(candidateModel, now)) {
    log.info(
      `[routing] Anthropic Sonnet suppressed; routing subagent to ${ANTHROPIC_RATE_LIMIT_FALLBACK_MODEL}`,
    );
    return {
      model: ANTHROPIC_RATE_LIMIT_FALLBACK_MODEL,
      route: "anthropic-nemotron",
      rateLimitFallback: true,
    };
  }

  return { model: candidateModel, route: anthropicLane };
}

export function buildAllowedModelSet(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
}): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
} {
  const rawAllowlist = (() => {
    const modelMap = params.cfg.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  const allowAny = rawAllowlist.length === 0;
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    defaultModel && params.defaultProvider
      ? parseModelRef(defaultModel, params.defaultProvider)
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
  const catalogKeys = new Set(params.catalog.map((entry) => modelKey(entry.provider, entry.id)));

  if (allowAny) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  const allowedKeys = new Set<string>();
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw), params.defaultProvider);
    if (!parsed) {
      continue;
    }
    const key = modelKey(parsed.provider, parsed.model);
    // Explicit allowlist entries are always trusted, even when bundled catalog
    // data is stale and does not include the configured model yet.
    allowedKeys.add(key);

    if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) {
      syntheticCatalogEntries.set(key, {
        id: parsed.model,
        name: parsed.model,
        provider: parsed.provider,
      });
    }
  }

  if (defaultKey) {
    allowedKeys.add(defaultKey);
  }

  const allowedCatalog = [
    ...params.catalog.filter((entry) => allowedKeys.has(modelKey(entry.provider, entry.id))),
    ...syntheticCatalogEntries.values(),
  ];

  if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: params.catalog,
      allowedKeys: catalogKeys,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys };
}

export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

export function getModelRefStatus(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
}): ModelRefStatus {
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: params.catalog.some((entry) => modelKey(entry.provider, entry.id) === key),
    allowAny: allowed.allowAny,
    allowed: allowed.allowAny || allowed.allowedKeys.has(key),
  };
}

export function resolveAllowedModelRef(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel?: string;
}):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const resolved = resolveModelRefFromString({
    raw: trimmed,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = getModelRefStatus({
    cfg: params.cfg,
    catalog: params.catalog,
    ref: resolved.ref,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const configured = params.cfg.agents?.defaults?.thinkingDefault;
  if (configured) {
    return configured;
  }
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  if (candidate?.reasoning) {
    return "low";
  }
  return "off";
}

/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
export function resolveReasoningDefault(params: {
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): "on" | "off" {
  const key = modelKey(params.provider, params.model);
  const candidate = params.catalog?.find(
    (entry) =>
      (entry.provider === params.provider && entry.id === params.model) ||
      (entry.provider === key && entry.id === params.model),
  );
  return candidate?.reasoning === true ? "on" : "off";
}

/**
 * Resolve the model configured for Gmail hook processing.
 * Returns null if hooks.gmail.model is not set.
 */
export function resolveHooksGmailModel(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });

  const resolved = resolveModelRefFromString({
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });

  return resolved?.ref ?? null;
}

/**
 * Normalize a model selection value (string or `{primary?: string}`) to a
 * plain trimmed string.  Returns `undefined` when the input is empty/missing.
 * Shared by sessions-spawn and cron isolated-agent model resolution.
 */
export function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}
