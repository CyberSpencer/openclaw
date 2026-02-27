import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";

type RerankEndpoint = {
  baseUrl: string;
  headers: Record<string, string>;
  priority: number;
  timeoutMs: number;
  healthUrl?: string;
  healthTimeoutMs?: number;
  healthCacheTtlMs?: number;
};

export type MemoryRerankRequest = {
  query: string;
  documents: Array<{ id: string; text: string }>;
  topN: number;
  model?: string;
};

export type MemoryRerankResponse = {
  ids: string[];
  endpoint: string;
  fallbackUsed: boolean;
};

export type MemoryRerankClient = {
  endpoints: RerankEndpoint[];
  activeEndpoint?: string;
  lastEndpointErrors: string[];
  lastError?: string;
  lastFallbackUsed: boolean;
  rerank(request: MemoryRerankRequest): Promise<MemoryRerankResponse>;
};

const DEFAULT_ENDPOINT_TIMEOUT_MS = 500;
const DEFAULT_HEALTH_TIMEOUT_MS = 1200;
const DEFAULT_HEALTH_CACHE_TTL_MS = 10_000;

const endpointHealthCache = new Map<string, { ok: boolean; checkedAt: number }>();

function normalizeBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  return value.replace(/\/+$/, "");
}

function endpointHealthCacheKey(endpoint: RerankEndpoint): string {
  return `${endpoint.baseUrl}::${endpoint.healthUrl ?? ""}`;
}

function markEndpointHealth(endpoint: RerankEndpoint, ok: boolean): void {
  const key = endpointHealthCacheKey(endpoint);
  endpointHealthCache.set(key, { ok, checkedAt: Date.now() });
}

async function fetchWithOptionalTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkEndpointHealth(endpoint: RerankEndpoint): Promise<boolean> {
  const url = endpoint.healthUrl?.trim() || `${endpoint.baseUrl}/health`;
  const ttlMs = endpoint.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS;
  const now = Date.now();
  const cacheKey = endpointHealthCacheKey(endpoint);
  const cached = endpointHealthCache.get(cacheKey);
  if (cached && now - cached.checkedAt < ttlMs) {
    return cached.ok;
  }

  const timeoutMs = endpoint.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  let ok = false;
  try {
    const res = await fetchWithOptionalTimeout(
      url,
      {
        method: "GET",
        headers: endpoint.headers,
      },
      timeoutMs,
    );
    ok = res.status === 200;
  } catch {
    ok = false;
  }
  endpointHealthCache.set(cacheKey, { ok, checkedAt: now });
  return ok;
}

function shouldFailoverStatus(status: number): boolean {
  if (status >= 500 && status <= 599) {
    return true;
  }
  return status === 408 || status === 429;
}

function normalizeRerankResponse(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  const dedupe = new Set<string>();
  for (const entry of results) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      dedupe.add(id);
    }
  }
  return Array.from(dedupe);
}

export function createMemoryRerankClient(
  config: ResolvedMemorySearchConfig["rerank"],
): MemoryRerankClient | null {
  const remote = config.remote;
  if (!remote) {
    return null;
  }

  const endpointMap = new Map<string, RerankEndpoint>();
  const globalHeaders = remote.headers ?? {};

  const upsert = (
    rawBaseUrl: string | undefined,
    entry?: {
      headers?: Record<string, string>;
      priority?: number;
      timeoutMs?: number;
      healthUrl?: string;
      healthTimeoutMs?: number;
      healthCacheTtlMs?: number;
    },
  ) => {
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (!baseUrl) {
      return;
    }
    const previous = endpointMap.get(baseUrl) ?? {
      baseUrl,
      headers: {
        "Content-Type": "application/json",
      },
      priority: 0,
      timeoutMs: config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_ENDPOINT_TIMEOUT_MS,
    };
    const mergedHeaders = {
      ...previous.headers,
      ...globalHeaders,
      ...entry?.headers,
    };
    endpointMap.set(baseUrl, {
      ...previous,
      headers: mergedHeaders,
      priority: entry?.priority ?? previous.priority,
      timeoutMs:
        typeof entry?.timeoutMs === "number" &&
        Number.isFinite(entry.timeoutMs) &&
        entry.timeoutMs > 0
          ? Math.floor(entry.timeoutMs)
          : previous.timeoutMs,
      healthUrl: entry?.healthUrl ?? previous.healthUrl,
      healthTimeoutMs: entry?.healthTimeoutMs ?? previous.healthTimeoutMs,
      healthCacheTtlMs: entry?.healthCacheTtlMs ?? previous.healthCacheTtlMs,
    });
  };

  upsert(remote.baseUrl, {
    timeoutMs: config.timeoutMs,
  });
  for (const entry of remote.endpoints ?? []) {
    upsert(entry.baseUrl, {
      headers: entry.headers,
      priority: entry.priority,
      timeoutMs: entry.timeoutMs,
      healthUrl: entry.healthUrl,
      healthTimeoutMs: entry.healthTimeoutMs,
      healthCacheTtlMs: entry.healthCacheTtlMs,
    });
  }

  const endpoints = Array.from(endpointMap.values()).toSorted((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.baseUrl.localeCompare(b.baseUrl);
  });

  if (endpoints.length === 0) {
    return null;
  }

  const client: MemoryRerankClient = {
    endpoints,
    activeEndpoint: endpoints[0]?.baseUrl,
    lastEndpointErrors: [],
    lastError: undefined,
    lastFallbackUsed: false,
    async rerank(request: MemoryRerankRequest): Promise<MemoryRerankResponse> {
      if (request.documents.length === 0) {
        return {
          ids: [],
          endpoint: this.activeEndpoint ?? endpoints[0]!.baseUrl,
          fallbackUsed: false,
        };
      }

      const preferred = this.activeEndpoint;
      const ordered = preferred
        ? [
            ...endpoints.filter((entry) => entry.baseUrl === preferred),
            ...endpoints.filter((entry) => entry.baseUrl !== preferred),
          ]
        : endpoints;
      const firstAttemptBase = ordered[0]?.baseUrl;
      const endpointErrors: string[] = [];

      for (const endpoint of ordered) {
        const healthy = await checkEndpointHealth(endpoint);
        if (!healthy) {
          endpointErrors.push(`${endpoint.baseUrl}: unhealthy`);
          continue;
        }

        const rerankUrl = `${endpoint.baseUrl}/v1/rerank`;
        try {
          const res = await fetchWithOptionalTimeout(
            rerankUrl,
            {
              method: "POST",
              headers: endpoint.headers,
              body: JSON.stringify({
                query: request.query,
                documents: request.documents,
                top_n: request.topN,
                ...(request.model ? { model: request.model } : {}),
              }),
            },
            endpoint.timeoutMs,
          );

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const detail = `${endpoint.baseUrl}: ${res.status} ${body.slice(0, 200)}`;
            if (shouldFailoverStatus(res.status)) {
              markEndpointHealth(endpoint, false);
              endpointErrors.push(detail);
              continue;
            }
            this.lastEndpointErrors = endpointErrors.concat(detail).slice(-3);
            this.lastFallbackUsed = endpoint.baseUrl !== firstAttemptBase;
            this.lastError = detail;
            throw new Error(`reranker request failed: ${detail}`);
          }

          const payload = await res.json().catch(() => ({}));
          const ids = normalizeRerankResponse(payload);
          markEndpointHealth(endpoint, true);
          this.activeEndpoint = endpoint.baseUrl;
          this.lastEndpointErrors = [];
          this.lastFallbackUsed = endpoint.baseUrl !== firstAttemptBase;
          this.lastError = undefined;
          return {
            ids,
            endpoint: endpoint.baseUrl,
            fallbackUsed: this.lastFallbackUsed,
          };
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("reranker request failed:")) {
            throw err;
          }
          markEndpointHealth(endpoint, false);
          const message = err instanceof Error ? err.message : String(err);
          endpointErrors.push(`${endpoint.baseUrl}: ${message}`);
        }
      }

      this.lastEndpointErrors = endpointErrors.slice(-3);
      this.lastFallbackUsed = true;
      this.lastError = this.lastEndpointErrors.join("; ");
      throw new Error(`reranker failed across all endpoints: ${this.lastError}`);
    },
  };

  return client;
}
