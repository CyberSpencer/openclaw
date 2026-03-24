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
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_QDRANT_PORT = 6333;
const DEFAULT_EMBED_PORT = 8010;
const DEFAULT_RERANK_PORT = 8011;
const DEFAULT_DGX_STATS_PORT = 9090;
const DEFAULT_VOICE_HEALTH_PORT = 9000;
const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;
const DGX_STATS_TIMEOUT_MS = 5000;

const CACHE_TTL_MS = 5000;
let lastCachedAt = 0;
let lastCachedResult: Record<string, unknown> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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

const DEFAULT_VLLM_PORT = 8004;

function resolveVllmHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "vllm");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  // SPARK_VLLM_HEALTH_URL takes priority (matches spark-vllm-coldstart.ts logic)
  const explicit = resolveUrlFromEnv(
    env.SPARK_VLLM_HEALTH_URL ?? process.env.SPARK_VLLM_HEALTH_URL,
  );
  if (explicit) {
    return explicit;
  }
  const base = resolveUrlFromEnv(env.DGX_VLLM_URL ?? process.env.DGX_VLLM_URL);
  if (base) {
    return appendUrlPath(new URL(base).origin, "health");
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_VLLM_PORT) ?? parseStringLike(process.env.DGX_VLLM_PORT),
    DEFAULT_VLLM_PORT,
  );
  return `http://${host}:${port}/health`;
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

function resolveEmbedHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  if (context?.mode === "wan") {
    const wanBase = resolveWanServiceBaseUrl(context, "embeddings");
    return wanBase ? appendUrlPath(wanBase, "health") : null;
  }
  const explicit = resolveUrlFromEnv(env.DGX_EMBED_URL ?? process.env.DGX_EMBED_URL);
  if (explicit) {
    return appendUrlPath(new URL(explicit).origin, "health");
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_EMBED_PORT) ?? parseStringLike(process.env.DGX_EMBED_PORT),
    DEFAULT_EMBED_PORT,
  );
  return `http://${host}:${port}/health`;
}

function resolveRerankHealthUrl(
  env: Record<string, string>,
  context: DgxAccessContext | null,
): string | null {
  const explicit = resolveUrlFromEnv(env.DGX_RERANK_URL ?? process.env.DGX_RERANK_URL);
  if (explicit) {
    return appendUrlPath(new URL(explicit).origin, "health");
  }
  const host = context?.lanHost ?? resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = resolvePort(
    parseStringLike(env.DGX_RERANK_PORT) ?? parseStringLike(process.env.DGX_RERANK_PORT),
    DEFAULT_RERANK_PORT,
  );
  return `http://${host}:${port}/health`;
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

/** Exported for unit tests. */
export function mapDgxStatsPayload(
  data: Record<string, unknown>,
  hostLabel: string | null,
  checkedAt: number,
): Record<string, unknown> {
  const overall = typeof data.overall === "string" ? data.overall : "unknown";
  const counts = data.counts;
  const rawServices = asRecord(data.services) ?? {};
  const services: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(rawServices)) {
    const svc = asRecord(raw);
    if (!svc) {
      continue;
    }
    const st = typeof svc.status === "string" ? svc.status : "";
    const code = typeof svc.code === "number" ? svc.code : st === "healthy" ? 200 : 503;
    const reason = typeof svc.reason === "string" ? svc.reason : "";
    services[name] = {
      healthy: st === "healthy",
      status: code,
      error: st === "healthy" || !reason ? null : reason,
      latency_ms: typeof svc.latency_ms === "number" ? svc.latency_ms : undefined,
    };
  }
  const voice = asRecord(data.voice);
  const vStt = services.voice_stt as { healthy?: boolean } | undefined;
  const vTts = services.voice_tts as { healthy?: boolean } | undefined;
  const voiceAvailable =
    typeof voice?.available === "boolean"
      ? voice.available
      : Boolean(vStt?.healthy && vTts?.healthy);

  // Override overall: only the 4 required DGX services determine health
  const CORE_SERVICES = ["vllm_nemotron", "qdrant", "embeddings", "reranker"];
  const coreStatuses = CORE_SERVICES.map((name) => {
    const svc = services[name] as { healthy?: boolean } | undefined;
    return svc ? { healthy: Boolean(svc.healthy) } : null;
  }).filter((s): s is { healthy: boolean } => s !== null);
  const derivedOverall: SparkOverall =
    coreStatuses.length === 0
      ? (overall as SparkOverall)
      : coreStatuses.every((s) => s.healthy)
        ? "healthy"
        : coreStatuses.some((s) => s.healthy)
          ? "degraded"
          : "down";

  const active = derivedOverall !== "down";

  return {
    enabled: true,
    active,
    source: "dgx-stats",
    host: hostLabel,
    checkedAt,
    voiceAvailable,
    overall: derivedOverall,
    counts,
    services,
    gpu: data.gpu ?? null,
    containers: Array.isArray(data.containers) ? data.containers : null,
  };
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
          const mappedServices = mapDgxServices(stats);

          // vLLM Nemotron health: DGX stats only reports the NVIDIA router (8001), not vLLM
          // directly. Derive vLLM health from whether VLLM::EngineCore appears in GPU processes
          // (authoritative — no WAN proxy path needed). Fall back to a direct probe on LAN.
          const vllmFromGpu = Array.isArray(stats.gpu?.processes)
            ? stats.gpu.processes.some(
                (p) => typeof p.process === "string" && /vllm/i.test(p.process),
              )
            : null;
          if (vllmFromGpu !== null) {
            mappedServices.vllm_nemotron = { healthy: vllmFromGpu };
          } else {
            // No GPU data — fall back to direct probe (LAN only; WAN has no vllm path)
            const vllmHealthUrl =
              context?.mode !== "wan" ? resolveVllmHealthUrl(env, context) : null;
            const vllmProbe = vllmHealthUrl ? await probeHealth(vllmHealthUrl, context) : null;
            if (vllmHealthUrl && vllmProbe) {
              mappedServices.vllm_nemotron = { url: vllmHealthUrl, ...vllmProbe };
            }
          }

          // Overall health requires the 4 core DGX services only — not the full DGX aggregate.
          // Core = vLLM Nemotron (GPU process check), Qdrant, Embeddings, Reranker.
          const CORE_STATS_SERVICES = ["vllm_nemotron", "qdrant", "embeddings", "reranker"];
          const coreStatProbes = CORE_STATS_SERVICES.map((name) => {
            const svc = mappedServices[name] as { healthy?: boolean } | undefined;
            return svc ? { healthy: Boolean(svc.healthy) } : null;
          }).filter((s): s is { healthy: boolean } => s !== null);
          const derivedOverall: SparkOverall =
            coreStatProbes.length === 0
              ? stats.overall
              : coreStatProbes.every((s) => s.healthy)
                ? "healthy"
                : coreStatProbes.some((s) => s.healthy)
                  ? "degraded"
                  : "down";
          const voiceAvailable = stats.voice?.available ?? false;
          const active = derivedOverall !== "down" || voiceAvailable;
          const payload = {
            enabled: true,
            active,
            host: activeHost,
            checkedAt,
            source: "dgx-stats" as const,
            voiceAvailable,
            overall: derivedOverall,
            counts: stats.counts ?? null,
            services: mappedServices,
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

      const vllmHealthUrl = resolveVllmHealthUrl(env, context);
      const qdrantBase = resolveQdrantBaseUrl(env, context);
      const embedHealthUrl = resolveEmbedHealthUrl(env, context);
      const rerankHealthUrl = resolveRerankHealthUrl(env, context);
      const voiceHealthUrl = resolveVoiceHealthUrl(env, context);
      const sttHealthUrl = resolveSttHealthUrl(env, context);
      const ttsHealthUrl = resolveTtsHealthUrl(env, context);

      const qdrantHealthUrl = qdrantBase
        ? appendUrlPath(normalizeBaseUrl(qdrantBase), "collections")
        : null;

      // The 4 required DGX services: vLLM Nemotron (port 8004), Qdrant, Embed, Reranker
      const [
        vllmProbe,
        qdrantProbe,
        embedProbe,
        rerankProbe,
        voiceHealthProbe,
        sttProbe,
        ttsProbe,
      ] = await Promise.all([
        vllmHealthUrl ? probeHealth(vllmHealthUrl, context) : Promise.resolve(null),
        qdrantHealthUrl ? probeHealth(qdrantHealthUrl, context) : Promise.resolve(null),
        embedHealthUrl ? probeHealth(embedHealthUrl, context) : Promise.resolve(null),
        rerankHealthUrl ? probeHealth(rerankHealthUrl, context) : Promise.resolve(null),
        voiceHealthUrl ? fetchVoiceHealth(voiceHealthUrl, context) : Promise.resolve(null),
        sttHealthUrl ? probeHealth(sttHealthUrl, context) : Promise.resolve(null),
        ttsHealthUrl ? probeHealth(ttsHealthUrl, context) : Promise.resolve(null),
      ]);

      if (vllmHealthUrl && vllmProbe) {
        services.vllm_nemotron = { url: vllmHealthUrl, ...vllmProbe };
      }
      if (qdrantHealthUrl && qdrantProbe) {
        services.qdrant = { url: qdrantHealthUrl, ...qdrantProbe };
      }
      if (embedHealthUrl && embedProbe) {
        services.embed = { url: embedHealthUrl, ...embedProbe };
      }
      if (rerankHealthUrl && rerankProbe) {
        services.reranker = { url: rerankHealthUrl, ...rerankProbe };
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
      // Overall health requires the 4 core DGX services: vLLM Nemotron, Qdrant, Embed, Reranker
      const overall = deriveOverallFromFallback([vllmProbe, qdrantProbe, embedProbe, rerankProbe]);
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
