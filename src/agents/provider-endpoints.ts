import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig, ModelProviderEndpointConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("providers/endpoints");

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_HEALTH_TTL_MS = 10_000;
const DEFAULT_SUCCESS_STATUSES = new Set([200]);

type HealthCacheEntry = { ok: boolean; checkedAt: number };
const healthCache = new Map<string, HealthCacheEntry>();

function cacheKey(providerId: string, endpoint: ModelProviderEndpointConfig): string {
  const id = endpoint.id?.trim() || endpoint.baseUrl.trim();
  return `${providerId}:${id}`;
}

function endpointId(endpoint: ModelProviderEndpointConfig): string {
  return endpoint.id?.trim() || endpoint.baseUrl.trim();
}

function resolveSuccessStatuses(endpoint: ModelProviderEndpointConfig): Set<number> {
  const statuses = endpoint.health?.successStatus;
  if (Array.isArray(statuses) && statuses.length > 0) {
    return new Set(statuses.map((value) => Math.trunc(value)));
  }
  return DEFAULT_SUCCESS_STATUSES;
}

async function checkHealth(
  providerId: string,
  endpoint: ModelProviderEndpointConfig,
): Promise<boolean> {
  if (!endpoint.health) {
    log.debug("provider endpoint has no health probe; treating as healthy", {
      event: "provider.endpoint.health",
      phase: "implicit-healthy",
      providerId,
      endpointId: endpointId(endpoint),
      baseUrl: endpoint.baseUrl,
      outcome: "healthy",
    });
    return true;
  }
  const now = Date.now();
  const ttl = endpoint.health.cacheTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  const key = cacheKey(providerId, endpoint);
  const cached = healthCache.get(key);
  if (cached && now - cached.checkedAt < ttl) {
    log.debug("provider endpoint health cache hit", {
      event: "provider.endpoint.health",
      phase: "cache",
      providerId,
      endpointId: endpointId(endpoint),
      baseUrl: endpoint.baseUrl,
      healthUrl: endpoint.health.url?.trim() || endpoint.baseUrl.trim(),
      outcome: cached.ok ? "healthy" : "unhealthy",
      cacheTtlMs: ttl,
    });
    return cached.ok;
  }

  const url = endpoint.health.url?.trim() || endpoint.baseUrl.trim();
  if (!url) {
    return true;
  }
  const method = endpoint.health.method ?? "GET";
  const timeoutMs = endpoint.health.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const successStatuses = resolveSuccessStatuses(endpoint);

  let ok = false;
  let status: number | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body: method === "POST" ? (endpoint.health.body ?? "") : undefined,
      signal: controller.signal,
    });
    status = res.status;
    ok = successStatuses.has(res.status);
  } catch (err) {
    ok = false;
    log.debug(`provider endpoint health check failed for ${providerId}: ${String(err)}`, {
      event: "provider.endpoint.health",
      phase: "error",
      providerId,
      endpointId: endpointId(endpoint),
      baseUrl: endpoint.baseUrl,
      healthUrl: url,
      timeoutMs,
      error: err instanceof Error ? err.message : String(err),
      outcome: "error",
    });
  } finally {
    clearTimeout(timer);
  }

  log.debug("provider endpoint health check completed", {
    event: "provider.endpoint.health",
    phase: "checked",
    providerId,
    endpointId: endpointId(endpoint),
    baseUrl: endpoint.baseUrl,
    healthUrl: url,
    method,
    timeoutMs,
    status,
    outcome: ok ? "healthy" : "unhealthy",
  });
  healthCache.set(key, { ok, checkedAt: now });
  return ok;
}

function sortEndpoints(endpoints: ModelProviderEndpointConfig[]): ModelProviderEndpointConfig[] {
  return [...endpoints].toSorted((a, b) => {
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a.baseUrl.localeCompare(b.baseUrl);
  });
}

function applyEndpoint(
  provider: ModelProviderConfig,
  endpoint: ModelProviderEndpointConfig,
): ModelProviderConfig {
  const headers = endpoint.headers
    ? { ...provider.headers, ...endpoint.headers }
    : provider.headers;
  return {
    ...provider,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? provider.apiKey,
    auth: endpoint.auth ?? provider.auth,
    headers,
    authHeader:
      typeof endpoint.authHeader === "boolean" ? endpoint.authHeader : provider.authHeader,
  };
}

export async function resolveProviderEndpoint(params: {
  providerId: string;
  provider: ModelProviderConfig;
}): Promise<{ provider: ModelProviderConfig; endpoint?: ModelProviderEndpointConfig }> {
  const { providerId, provider } = params;
  const endpoints = provider.endpoints?.filter((entry) => entry.baseUrl?.trim());
  if (!endpoints || endpoints.length === 0) {
    return { provider };
  }
  const strategy = provider.endpointStrategy ?? "health";
  const ordered = sortEndpoints(endpoints);

  if (strategy === "ordered") {
    const endpoint = ordered[0];
    if (!endpoint) {
      return { provider };
    }
    log.info("provider endpoint selected", {
      event: "provider.endpoint.selection",
      phase: "selected",
      providerId,
      strategy,
      endpointId: endpointId(endpoint),
      baseUrl: endpoint.baseUrl,
      endpointCount: ordered.length,
      failoverUsed: false,
      outcome: "selected",
    });
    return { provider: applyEndpoint(provider, endpoint), endpoint };
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const endpoint = ordered[index];
    if (await checkHealth(providerId, endpoint)) {
      log.info("provider endpoint selected", {
        event: "provider.endpoint.selection",
        phase: index > 0 ? "failover" : "selected",
        providerId,
        strategy,
        endpointId: endpointId(endpoint),
        baseUrl: endpoint.baseUrl,
        endpointCount: ordered.length,
        attempt: index + 1,
        failoverUsed: index > 0,
        outcome: "selected",
      });
      return { provider: applyEndpoint(provider, endpoint), endpoint };
    }
  }

  log.warn(
    `provider endpoint health checks failed for ${providerId}, falling back to base provider`,
    {
      event: "provider.endpoint.selection",
      phase: "fallback-base",
      providerId,
      strategy,
      endpointCount: ordered.length,
      endpoints: ordered.map((endpoint) => endpointId(endpoint)),
      baseUrl: provider.baseUrl,
      outcome: "fallback_base",
    },
  );
  return { provider };
}

export async function resolveProviderEndpointConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): Promise<{ cfg: OpenClawConfig; endpoint?: ModelProviderEndpointConfig }> {
  const providers = params.cfg.models?.providers;
  if (!providers) {
    return { cfg: params.cfg };
  }
  const provider = providers[params.providerId];
  if (!provider) {
    return { cfg: params.cfg };
  }
  const resolved = await resolveProviderEndpoint({
    providerId: params.providerId,
    provider,
  });
  if (resolved.provider === provider) {
    return { cfg: params.cfg, endpoint: resolved.endpoint };
  }
  return {
    cfg: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        providers: {
          ...providers,
          [params.providerId]: resolved.provider,
        },
      },
    },
    endpoint: resolved.endpoint,
  };
}
