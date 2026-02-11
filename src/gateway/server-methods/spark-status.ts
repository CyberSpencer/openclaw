import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  appendUrlPath,
  mergeDgxRequestHeaders,
  normalizeBaseUrl,
  parseStringLike,
  resolveDgxAccess,
  resolveDgxEnabled,
  resolveDgxHost,
  resolveEffectiveEnv,
  resolveWanServiceBaseUrl,
  type DgxAccessContext,
} from "./dgx-access.js";

const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_QDRANT_PORT = 6333;
const DEFAULT_DGX_STATS_PORT = 9090;
const DEFAULT_VOICE_HEALTH_PORT = 9000;
const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;
const DGX_STATS_TIMEOUT_MS = 5000;

const CACHE_TTL_MS = 5000;
let lastCachedAt = 0;
let lastCachedResult: Record<string, unknown> | null = null;

function resolveUrlFromEnv(raw: string | undefined): string | undefined {
  const value = parseStringLike(raw);
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function resolvePort(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveRouterHealthUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function probeHealth(
  url: string,
  context: DgxAccessContext | null,
): Promise<{
  healthy: boolean;
  status?: number;
  error?: string;
}> {
  const timeoutMs = 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: mergeDgxRequestHeaders(context, { accept: "application/json" }),
      signal: controller.signal,
    });
    return {
      healthy: response.ok,
      status: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveDgxStatsPort(env: Record<string, string>): number {
  return resolvePort(
    parseStringLike(env.DGX_STATS_PORT) ?? parseStringLike(process.env.DGX_STATS_PORT),
    DEFAULT_DGX_STATS_PORT,
  );
}

function resolveRouterHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "router");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  const explicit = resolveUrlFromEnv(env.DGX_ROUTER_URL ?? process.env.DGX_ROUTER_URL);
  if (explicit) {
    return deriveRouterHealthUrl(explicit);
  }
  const fallback = resolveUrlFromEnv(
    env.OPENCLAW_NVIDIA_ROUTER_URL ?? process.env.OPENCLAW_NVIDIA_ROUTER_URL,
  );
  return fallback ? deriveRouterHealthUrl(fallback) : null;
}

function resolveOllamaBaseUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | undefined {
  if (context?.mode === "wan") {
    return resolveWanServiceBaseUrl(context, "ollama");
  }

  const explicit = resolveUrlFromEnv(env.DGX_OLLAMA_URL ?? process.env.DGX_OLLAMA_URL);
  if (explicit) {
    return explicit;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = resolvePort(
    parseStringLike(env.OLLAMA_PORT) ?? parseStringLike(process.env.OLLAMA_PORT),
    DEFAULT_OLLAMA_PORT,
  );
  return `http://${host}:${port}`;
}

function resolveQdrantBaseUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | undefined {
  if (context?.mode === "wan") {
    return resolveWanServiceBaseUrl(context, "qdrant");
  }

  const explicit = resolveUrlFromEnv(env.DGX_QDRANT_URL ?? process.env.DGX_QDRANT_URL);
  if (explicit) {
    return explicit;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = resolvePort(
    parseStringLike(env.QDRANT_HTTP_PORT) ?? parseStringLike(process.env.QDRANT_HTTP_PORT),
    DEFAULT_QDRANT_PORT,
  );
  return `http://${host}:${port}`;
}

function resolveSttHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "voiceStt");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_STT_PORT ?? process.env.DGX_STT_PORT),
    DEFAULT_STT_PORT,
  );
  return `http://${host}:${port}/health`;
}

function resolveTtsHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "voiceTts");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_TTS_PORT ?? process.env.DGX_TTS_PORT),
    DEFAULT_TTS_PORT,
  );
  return `http://${host}:${port}/health`;
}

/** Consolidated DGX voice health (STT+TTS) at e.g. :9000/health. Returns { status, stt, tts }. */
function resolveVoiceHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "voiceHealth");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_VOICE_HEALTH_PORT ?? process.env.DGX_VOICE_HEALTH_PORT),
    DEFAULT_VOICE_HEALTH_PORT,
  );
  return `http://${host}:${port}/health`;
}

async function fetchVoiceHealth(
  url: string,
  context: DgxAccessContext | null,
): Promise<{
  healthy: boolean;
  stt?: boolean;
  tts?: boolean;
  status?: number;
  error?: string;
}> {
  const timeoutMs = 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: mergeDgxRequestHeaders(context, { accept: "application/json" }),
      signal: controller.signal,
    });
    const body = response.ok
      ? ((await response.json()) as { stt?: boolean; tts?: boolean })
      : undefined;
    return {
      healthy: response.ok,
      status: response.status,
      stt: body?.stt,
      tts: body?.tts,
    };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// DGX Stats consolidated endpoint
// ---------------------------------------------------------------------------

interface DgxStatsResponse {
  overall: "healthy" | "degraded" | "down";
  timestamp?: string;
  counts?: { healthy: number; degraded: number; down: number; total: number };
  services?: Record<
    string,
    {
      status: "healthy" | "degraded" | "down";
      code?: number;
      latency_ms?: number;
      reason?: string;
      details?: Record<string, unknown>;
    }
  >;
  gpu?: {
    name?: string;
    temperature_c?: number;
    power_w?: number;
    utilization_pct?: number;
    memory_used_mib?: number;
    memory_total_mib?: number;
    unified_memory?: boolean;
    processes?: Array<{ pid: number; memory_mib: number; process: string }>;
  };
  containers?: Array<{
    name: string;
    cpu?: string;
    memory?: string;
    mem_pct?: string;
    net_io?: string;
    block_io?: string;
  }>;
  voice?: {
    available: boolean;
    stt: boolean;
    tts: boolean;
  };
}

function resolveDgxStatsUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const dashboardBase = resolveWanServiceBaseUrl(context, "dashboard");
    return dashboardBase ? appendUrlPath(dashboardBase, "api/dgx-stats") : null;
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  return `http://${host}:${resolveDgxStatsPort(env)}/api/dgx-stats`;
}

async function fetchDgxStats(
  url: string,
  context: DgxAccessContext | null,
): Promise<DgxStatsResponse | null> {
  const timeoutMs = DGX_STATS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: mergeDgxRequestHeaders(context, { accept: "application/json" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as DgxStatsResponse;
    if (!data || typeof data.overall !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type SparkOverall = "healthy" | "degraded" | "down" | "unknown";

function deriveOverallFromFallback(probes: Array<{ healthy: boolean } | null>): SparkOverall {
  const filtered = probes.filter((probe): probe is { healthy: boolean } => probe !== null);
  if (filtered.length === 0) {
    return "unknown";
  }
  const healthyCount = filtered.filter((probe) => probe.healthy).length;
  if (healthyCount === 0) {
    return "down";
  }
  if (healthyCount === filtered.length) {
    return "healthy";
  }
  return "degraded";
}

/** Map DGX Stats services to the legacy per-service shape used by the UI. */
function mapDgxServices(
  stats: DgxStatsResponse,
): Record<
  string,
  { url?: string; healthy: boolean; status?: number; error?: string | null; latency_ms?: number }
> {
  const result: Record<
    string,
    { url?: string; healthy: boolean; status?: number; error?: string | null; latency_ms?: number }
  > = {};
  if (!stats.services) {
    return result;
  }
  for (const [name, svc] of Object.entries(stats.services)) {
    result[name] = {
      healthy: svc.status === "healthy",
      status: svc.code,
      error: svc.status !== "healthy" ? svc.reason || svc.status : null,
      latency_ms: svc.latency_ms,
    };
  }
  return result;
}

export const sparkStatusHandlers: GatewayRequestHandlers = {
  "spark.status": async ({ respond }) => {
    const now = Date.now();
    if (lastCachedResult && now - lastCachedAt < CACHE_TTL_MS) {
      respond(true, lastCachedResult, undefined);
      return;
    }

    try {
      const env = resolveEffectiveEnv();
      const enabled = resolveDgxEnabled(env);
      const configuredHost = resolveDgxHost(env);
      const checkedAt = Date.now();

      if (!enabled) {
        const payload = {
          enabled: false,
          active: false,
          host: configuredHost ?? null,
          checkedAt,
          source: "fallback" as const,
          voiceAvailable: false,
          overall: "unknown" as SparkOverall,
        };
        lastCachedAt = now;
        lastCachedResult = payload;
        respond(true, payload, undefined);
        return;
      }

      const access = await resolveDgxAccess(env);
      const context = access.context;
      const activeHost = context?.host ?? configuredHost ?? null;
      if (!context) {
        const payload = {
          enabled: true,
          active: false,
          host: activeHost,
          checkedAt,
          source: "fallback" as const,
          voiceAvailable: false,
          overall: "down" as SparkOverall,
          error: access.error ?? "DGX endpoint is not configured",
        };
        lastCachedAt = now;
        lastCachedResult = payload;
        respond(true, payload, undefined);
        return;
      }

      const statsUrl = resolveDgxStatsUrl(env, context);
      if (statsUrl) {
        const stats = await fetchDgxStats(statsUrl, context);
        if (stats) {
          const payload = {
            enabled: true,
            active: stats.overall !== "down",
            host: activeHost,
            checkedAt,
            source: "dgx-stats" as const,
            voiceAvailable: stats.voice?.available ?? false,
            overall: stats.overall,
            counts: stats.counts ?? null,
            services: mapDgxServices(stats),
            gpu: stats.gpu ?? null,
            containers: stats.containers ?? null,
          };
          lastCachedAt = now;
          lastCachedResult = payload;
          respond(true, payload, undefined);
          return;
        }
      }

      const services: Record<string, unknown> = {};

      const routerHealthUrl = resolveRouterHealthUrl(env, context);
      const ollamaBase = resolveOllamaBaseUrl(env, context);
      const qdrantBase = resolveQdrantBaseUrl(env, context);
      const voiceHealthUrl = resolveVoiceHealthUrl(env, context);
      const sttHealthUrl = resolveSttHealthUrl(env, context);
      const ttsHealthUrl = resolveTtsHealthUrl(env, context);

      const ollamaHealthUrl = ollamaBase
        ? appendUrlPath(normalizeBaseUrl(ollamaBase), "api/tags")
        : null;
      const qdrantHealthUrl = qdrantBase
        ? appendUrlPath(normalizeBaseUrl(qdrantBase), "collections")
        : null;

      const [routerProbe, ollamaProbe, qdrantProbe, voiceHealthProbe, sttProbe, ttsProbe] =
        await Promise.all([
          routerHealthUrl ? probeHealth(routerHealthUrl, context) : Promise.resolve(null),
          ollamaHealthUrl ? probeHealth(ollamaHealthUrl, context) : Promise.resolve(null),
          qdrantHealthUrl ? probeHealth(qdrantHealthUrl, context) : Promise.resolve(null),
          voiceHealthUrl ? fetchVoiceHealth(voiceHealthUrl, context) : Promise.resolve(null),
          sttHealthUrl ? probeHealth(sttHealthUrl, context) : Promise.resolve(null),
          ttsHealthUrl ? probeHealth(ttsHealthUrl, context) : Promise.resolve(null),
        ]);

      if (routerHealthUrl && routerProbe) {
        services.router = { url: routerHealthUrl, ...routerProbe };
      }
      if (ollamaHealthUrl && ollamaProbe) {
        services.ollama = { url: ollamaHealthUrl, ...ollamaProbe };
      }
      if (qdrantHealthUrl && qdrantProbe) {
        services.qdrant = { url: qdrantHealthUrl, ...qdrantProbe };
      }
      if (voiceHealthUrl && voiceHealthProbe) {
        services.voice_health = { url: voiceHealthUrl, ...voiceHealthProbe };
      }
      if (sttHealthUrl && sttProbe) {
        services.voice_stt = { url: sttHealthUrl, ...sttProbe };
      }
      if (ttsHealthUrl && ttsProbe) {
        services.voice_tts = { url: ttsHealthUrl, ...ttsProbe };
      }

      const voiceAvailable = Boolean(
        (voiceHealthProbe?.healthy && voiceHealthProbe?.stt && voiceHealthProbe?.tts) ||
        (sttProbe?.healthy && ttsProbe?.healthy),
      );
      const overall = deriveOverallFromFallback([
        routerProbe,
        ollamaProbe,
        qdrantProbe,
        voiceHealthProbe,
        sttProbe,
        ttsProbe,
      ]);
      const active = overall === "healthy" || overall === "degraded";

      const payload = {
        enabled: true,
        active,
        host: activeHost,
        checkedAt,
        source: "fallback" as const,
        voiceAvailable,
        overall,
        services,
      };

      lastCachedAt = now;
      lastCachedResult = payload;
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
