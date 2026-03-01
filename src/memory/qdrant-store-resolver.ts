import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";

export type QdrantEndpointConfig = {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  priority?: number;
  healthUrl?: string;
  healthTimeoutMs?: number;
  healthCacheTtlMs?: number;
};

export type QdrantConfig = {
  url: string;
  endpoints?: QdrantEndpointConfig[];
  collection: string;
  apiKey?: string;
  timeoutMs: number;
};

export type QdrantResolverLogger = {
  warn: (message: string) => void;
  debug: (message: string) => void;
};

const NOOP_LOGGER: QdrantResolverLogger = {
  warn: () => undefined,
  debug: () => undefined,
};

const QDRANT_HEALTH_TTL_MS = 10_000;
const QDRANT_HEALTH_TIMEOUT_MS = 1500;
const qdrantHealthCache = new Map<string, { ok: boolean; checkedAt: number }>();

function normalizeQdrantUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function checkQdrantEndpoint(
  endpoint: QdrantEndpointConfig,
  fallbackApiKey?: string,
  logger: QdrantResolverLogger = NOOP_LOGGER,
): Promise<boolean> {
  const url = endpoint.healthUrl?.trim() || `${normalizeQdrantUrl(endpoint.url)}/collections`;
  const timeoutMs = endpoint.healthTimeoutMs ?? QDRANT_HEALTH_TIMEOUT_MS;
  const ttlMs = endpoint.healthCacheTtlMs ?? QDRANT_HEALTH_TTL_MS;
  const cacheKey = endpoint.url;
  const now = Date.now();
  const cached = qdrantHealthCache.get(cacheKey);
  if (cached && now - cached.checkedAt < ttlMs) {
    return cached.ok;
  }

  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiKey = endpoint.apiKey ?? fallbackApiKey;
    const headers: Record<string, string> = {
      ...endpoint.headers,
    };
    if (apiKey) {
      headers["api-key"] = apiKey;
    }
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    ok = res.status === 200;
  } catch (err) {
    ok = false;
    logger.debug(`qdrant health check failed for ${endpoint.url}: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  qdrantHealthCache.set(cacheKey, { ok, checkedAt: now });
  return ok;
}

export function sortQdrantEndpoints(endpoints: QdrantEndpointConfig[]): QdrantEndpointConfig[] {
  return [...endpoints].toSorted((a, b) => {
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a.url.localeCompare(b.url);
  });
}

async function resolveQdrantEndpoint(
  config: QdrantConfig,
  logger: QdrantResolverLogger,
): Promise<QdrantConfig | null> {
  const endpoints = (config.endpoints ?? []).filter((entry) => entry.url?.trim());
  if (endpoints.length === 0) {
    return config;
  }

  const ordered = sortQdrantEndpoints(endpoints);
  for (const endpoint of ordered) {
    if (await checkQdrantEndpoint(endpoint, config.apiKey, logger)) {
      return {
        ...config,
        url: endpoint.url,
        apiKey: endpoint.apiKey ?? config.apiKey,
        timeoutMs: endpoint.timeoutMs ?? config.timeoutMs,
      };
    }
  }

  return null;
}

export async function resolveStoreSettings(
  settings: ResolvedMemorySearchConfig,
  logger: QdrantResolverLogger,
): Promise<ResolvedMemorySearchConfig> {
  if (settings.store.driver !== "auto" && settings.store.driver !== "qdrant") {
    return settings;
  }

  const resolvedQdrant = await resolveQdrantEndpoint(settings.store.qdrant as QdrantConfig, logger);
  if (resolvedQdrant) {
    return {
      ...settings,
      store: {
        ...settings.store,
        driver: "qdrant",
        qdrant: resolvedQdrant,
      },
    };
  }

  if (settings.store.driver === "auto") {
    logger.warn("qdrant unavailable, falling back to sqlite memory store");
    return {
      ...settings,
      store: {
        ...settings.store,
        driver: "sqlite",
      },
    };
  }

  return settings;
}
