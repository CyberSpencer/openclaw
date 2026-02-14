import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";

type OpenAiEmbeddingEndpoint = {
  baseUrl: string;
  headers: Record<string, string>;
  priority: number;
  timeoutMs?: number;
  healthUrl?: string;
  healthTimeoutMs?: number;
  healthCacheTtlMs?: number;
};

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  endpoints: OpenAiEmbeddingEndpoint[];
  activeEndpoint?: string;
  lastEndpointErrors?: string[];
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ENDPOINT_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_HEALTH_CACHE_TTL_MS = 10_000;

const endpointHealthCache = new Map<string, { ok: boolean; checkedAt: number }>();

export function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("openai/")) {
    return trimmed.slice("openai/".length);
  }
  return trimmed;
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const preferredBase = client.activeEndpoint;
    const ordered = preferredBase
      ? [
          ...client.endpoints.filter((entry) => entry.baseUrl === preferredBase),
          ...client.endpoints.filter((entry) => entry.baseUrl !== preferredBase),
        ]
      : client.endpoints;

    const endpointErrors: string[] = [];
    for (const endpoint of ordered) {
      const healthy = await checkEndpointHealth(endpoint);
      if (!healthy) {
        endpointErrors.push(`${endpoint.baseUrl}: unhealthy`);
        continue;
      }
      const url = `${endpoint.baseUrl.replace(/\/$/, "")}/embeddings`;
      try {
        const res = await fetchWithOptionalTimeout(
          url,
          {
            method: "POST",
            headers: endpoint.headers,
            body: JSON.stringify({ model: client.model, input }),
          },
          endpoint.timeoutMs,
        );
        if (!res.ok) {
          const text = await res.text();
          endpointErrors.push(`${endpoint.baseUrl}: ${res.status} ${text.slice(0, 200)}`);
          continue;
        }
        const payload = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const data = payload.data ?? [];
        markEndpointHealth(endpoint, true);
        client.activeEndpoint = endpoint.baseUrl;
        client.lastEndpointErrors = [];
        return data.map((entry) => entry.embedding ?? []);
      } catch (err) {
        markEndpointHealth(endpoint, false);
        const message = err instanceof Error ? err.message : String(err);
        endpointErrors.push(`${endpoint.baseUrl}: ${message}`);
      }
    }
    client.lastEndpointErrors = endpointErrors.slice(-3);
    const summary = client.lastEndpointErrors.join("; ");
    throw new Error(`openai embeddings failed across all endpoints: ${summary}`);
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const endpointInputs = remote?.endpoints ?? [];
  const hasEndpointApiKey = endpointInputs.some(
    (entry) => typeof entry.apiKey === "string" && entry.apiKey.trim().length > 0,
  );

  const resolvedApiKey = remoteApiKey
    ? remoteApiKey
    : !hasEndpointApiKey
      ? requireApiKey(
          await resolveApiKeyForProvider({
            provider: "openai",
            cfg: options.config,
            agentDir: options.agentDir,
          }),
          "openai",
        )
      : undefined;

  const providerConfig = options.config.models?.providers?.openai;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
  const globalHeaderOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...globalHeaderOverrides,
  };
  if (resolvedApiKey) {
    baseHeaders.Authorization = `Bearer ${resolvedApiKey}`;
  }
  const endpointsMap = new Map<string, OpenAiEmbeddingEndpoint>();
  if (endpointInputs.length > 0) {
    for (const raw of endpointInputs) {
      const resolvedBaseUrl = (raw.baseUrl ?? raw.url ?? "").trim().replace(/\/+$/, "");
      if (!resolvedBaseUrl) {
        continue;
      }
      const endpointApiKey = raw.apiKey?.trim();
      const endpointHeaders: Record<string, string> = {
        ...baseHeaders,
        ...raw.headers,
      };
      if (endpointApiKey) {
        endpointHeaders.Authorization = `Bearer ${endpointApiKey}`;
      }
      endpointsMap.set(resolvedBaseUrl, {
        baseUrl: resolvedBaseUrl,
        headers: endpointHeaders,
        priority: raw.priority ?? 0,
        timeoutMs:
          typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
            ? Math.floor(raw.timeoutMs)
            : DEFAULT_ENDPOINT_TIMEOUT_MS,
        healthUrl: raw.healthUrl?.trim() || undefined,
        healthTimeoutMs:
          typeof raw.healthTimeoutMs === "number" &&
          Number.isFinite(raw.healthTimeoutMs) &&
          raw.healthTimeoutMs > 0
            ? Math.floor(raw.healthTimeoutMs)
            : undefined,
        healthCacheTtlMs:
          typeof raw.healthCacheTtlMs === "number" &&
          Number.isFinite(raw.healthCacheTtlMs) &&
          raw.healthCacheTtlMs > 0
            ? Math.floor(raw.healthCacheTtlMs)
            : undefined,
      });
    }
  }
  if (endpointsMap.size === 0) {
    endpointsMap.set(baseUrl, {
      baseUrl,
      headers: baseHeaders,
      priority: 0,
      timeoutMs: DEFAULT_ENDPOINT_TIMEOUT_MS,
      healthUrl: undefined,
      healthTimeoutMs: undefined,
      healthCacheTtlMs: undefined,
    });
  }
  const endpoints = Array.from(endpointsMap.values()).toSorted((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.baseUrl.localeCompare(b.baseUrl);
  });
  const model = normalizeOpenAiModel(options.model);
  return {
    baseUrl: endpoints[0]?.baseUrl ?? baseUrl,
    headers: endpoints[0]?.headers ?? baseHeaders,
    model,
    endpoints,
    activeEndpoint: endpoints[0]?.baseUrl ?? baseUrl,
    lastEndpointErrors: [],
  };
}

function endpointHealthCacheKey(endpoint: OpenAiEmbeddingEndpoint): string {
  return `${endpoint.baseUrl}::${endpoint.healthUrl ?? ""}`;
}

function markEndpointHealth(endpoint: OpenAiEmbeddingEndpoint, ok: boolean): void {
  if (!endpoint.healthUrl) {
    return;
  }
  endpointHealthCache.set(endpointHealthCacheKey(endpoint), {
    ok,
    checkedAt: Date.now(),
  });
}

async function checkEndpointHealth(endpoint: OpenAiEmbeddingEndpoint): Promise<boolean> {
  if (!endpoint.healthUrl) {
    return true;
  }
  const cacheKey = endpointHealthCacheKey(endpoint);
  const ttlMs = endpoint.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS;
  const now = Date.now();
  const cached = endpointHealthCache.get(cacheKey);
  if (cached && now - cached.checkedAt < ttlMs) {
    return cached.ok;
  }

  const timeoutMs = endpoint.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint.healthUrl, {
      method: "GET",
      headers: endpoint.headers,
      signal: controller.signal,
    });
    const ok = res.ok;
    endpointHealthCache.set(cacheKey, { ok, checkedAt: now });
    return ok;
  } catch {
    endpointHealthCache.set(cacheKey, { ok: false, checkedAt: now });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithOptionalTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
