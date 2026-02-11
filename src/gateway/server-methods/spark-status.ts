import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_QDRANT_PORT = 6333;
const DEFAULT_DGX_STATS_PORT = 9090;
const DEFAULT_VOICE_HEALTH_PORT = 9000;
const DEFAULT_STT_PORT = 9001;
const DEFAULT_TTS_PORT = 9002;

const CACHE_TTL_MS = 5000;
let lastCachedAt = 0;
let lastCachedResult: Record<string, unknown> | null = null;

function parseBooleanLike(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseStringLike(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  return unquoted.trim() || undefined;
}

function resolveContractPath(): string | null {
  const explicit = process.env.OPENCLAW_CONTRACT?.trim();
  if (explicit) {
    return explicit;
  }
  const fallback = path.resolve(process.cwd(), "config", "workspace.env");
  return existsSync(fallback) ? fallback : null;
}

function readContractEnv(contractPath: string | null): Record<string, string> {
  if (!contractPath || !existsSync(contractPath)) {
    return {};
  }
  try {
    const result: Record<string, string> = {};
    const lines = readFileSync(contractPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const idx = trimmed.indexOf("=");
      if (idx < 0) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      if (!key) {
        continue;
      }
      const value = trimmed.slice(idx + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function resolveUrlFromEnv(raw: string | undefined): string | undefined {
  const value = parseStringLike(raw);
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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

async function probeHealth(url: string): Promise<{
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
      headers: { accept: "application/json" },
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

function resolveEffectiveEnv(): Record<string, string> {
  const base = readContractEnv(resolveContractPath());
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return base;
}

function resolveDgxEnabled(env: Record<string, string>): boolean {
  return Boolean(parseBooleanLike(env.DGX_ENABLED) ?? parseBooleanLike(process.env.DGX_ENABLED));
}

function resolveDgxHost(env: Record<string, string>): string | undefined {
  return parseStringLike(env.DGX_HOST) ?? parseStringLike(process.env.DGX_HOST);
}

function resolveDgxStatsPort(env: Record<string, string>): number {
  const raw = parseStringLike(env.DGX_STATS_PORT) ?? parseStringLike(process.env.DGX_STATS_PORT);
  const port = raw ? Number(raw) : DEFAULT_DGX_STATS_PORT;
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_DGX_STATS_PORT;
}

function resolveOllamaUrl(env: Record<string, string>): string | undefined {
  const explicit = resolveUrlFromEnv(env.DGX_OLLAMA_URL ?? process.env.DGX_OLLAMA_URL);
  if (explicit) {
    return explicit;
  }
  const host = resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = Number(
    parseStringLike(env.OLLAMA_PORT) ??
      parseStringLike(process.env.OLLAMA_PORT) ??
      DEFAULT_OLLAMA_PORT,
  );
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_OLLAMA_PORT}`;
}

function resolveQdrantUrl(env: Record<string, string>): string | undefined {
  const explicit = resolveUrlFromEnv(env.DGX_QDRANT_URL ?? process.env.DGX_QDRANT_URL);
  if (explicit) {
    return explicit;
  }
  const host = resolveDgxHost(env);
  if (!host) {
    return undefined;
  }
  const port = Number(
    parseStringLike(env.QDRANT_HTTP_PORT) ??
      parseStringLike(process.env.QDRANT_HTTP_PORT) ??
      DEFAULT_QDRANT_PORT,
  );
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_QDRANT_PORT}`;
}

function resolveRouterUrl(env: Record<string, string>): string | undefined {
  const explicit = resolveUrlFromEnv(env.DGX_ROUTER_URL ?? process.env.DGX_ROUTER_URL);
  if (explicit) {
    return explicit;
  }
  // OPENCLAW_NVIDIA_ROUTER_URL is often pointed at the DGX router when DGX is enabled.
  return resolveUrlFromEnv(
    env.OPENCLAW_NVIDIA_ROUTER_URL ?? process.env.OPENCLAW_NVIDIA_ROUTER_URL,
  );
}

function resolveSttHealthUrl(env: Record<string, string>): string | null {
  const host = resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = Number(
    parseStringLike(env.DGX_STT_PORT ?? process.env.DGX_STT_PORT) ?? DEFAULT_STT_PORT,
  );
  return Number.isFinite(port) && port > 0 ? `http://${host}:${port}/health` : null;
}

function resolveTtsHealthUrl(env: Record<string, string>): string | null {
  const host = resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = Number(
    parseStringLike(env.DGX_TTS_PORT ?? process.env.DGX_TTS_PORT) ?? DEFAULT_TTS_PORT,
  );
  return Number.isFinite(port) && port > 0 ? `http://${host}:${port}/health` : null;
}

/** Consolidated DGX voice health (STT+TTS) at e.g. :9000/health. Returns { status, stt, tts }. */
function resolveVoiceHealthUrl(env: Record<string, string>): string | null {
  const host = resolveDgxHost(env);
  if (!host) {
    return null;
  }
  const port = Number(
    parseStringLike(env.DGX_VOICE_HEALTH_PORT ?? process.env.DGX_VOICE_HEALTH_PORT) ??
      DEFAULT_VOICE_HEALTH_PORT,
  );
  return Number.isFinite(port) && port > 0 ? `http://${host}:${port}/health` : null;
}

async function fetchVoiceHealth(url: string): Promise<{
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
      headers: { accept: "application/json" },
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

async function fetchDgxStats(host: string, port: number): Promise<DgxStatsResponse | null> {
  const url = `http://${host}:${port}/api/dgx-stats`;
  const timeoutMs = 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
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
      const host = resolveDgxHost(env);
      const checkedAt = Date.now();

      if (!enabled) {
        const payload = { enabled: false, active: false, host: host ?? null, checkedAt };
        lastCachedAt = now;
        lastCachedResult = payload;
        respond(true, payload, undefined);
        return;
      }

      // --- Try consolidated dgx-stats endpoint first ---
      if (host) {
        const statsPort = resolveDgxStatsPort(env);
        const stats = await fetchDgxStats(host, statsPort);
        if (stats) {
          const payload = {
            enabled: true,
            active: stats.overall !== "down",
            host,
            checkedAt,
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

      // --- Fallback: probe individual endpoints (DGX voice: consolidated :9000/health or STT/TTS) ---
      const services: Record<string, unknown> = {};

      const routerUrl = resolveRouterUrl(env);
      const routerHealth = routerUrl ? deriveRouterHealthUrl(routerUrl) : null;
      const ollamaUrl = resolveOllamaUrl(env);
      const qdrantUrl = resolveQdrantUrl(env);
      const voiceHealthUrl = resolveVoiceHealthUrl(env);
      const sttHealthUrl = resolveSttHealthUrl(env);
      const ttsHealthUrl = resolveTtsHealthUrl(env);

      const [routerProbe, ollamaProbe, qdrantProbe, voiceHealthProbe, sttProbe, ttsProbe] =
        await Promise.all([
          routerHealth ? probeHealth(routerHealth) : Promise.resolve(null),
          ollamaUrl
            ? probeHealth(`${normalizeBaseUrl(ollamaUrl)}/api/tags`)
            : Promise.resolve(null),
          qdrantUrl
            ? probeHealth(`${normalizeBaseUrl(qdrantUrl)}/collections`)
            : Promise.resolve(null),
          voiceHealthUrl ? fetchVoiceHealth(voiceHealthUrl) : Promise.resolve(null),
          sttHealthUrl ? probeHealth(sttHealthUrl) : Promise.resolve(null),
          ttsHealthUrl ? probeHealth(ttsHealthUrl) : Promise.resolve(null),
        ]);

      if (routerHealth && routerProbe) {
        services.router = { url: routerHealth, ...routerProbe };
      }
      if (ollamaUrl && ollamaProbe) {
        services.ollama = { url: `${normalizeBaseUrl(ollamaUrl)}/api/tags`, ...ollamaProbe };
      }
      if (qdrantUrl && qdrantProbe) {
        services.qdrant = { url: `${normalizeBaseUrl(qdrantUrl)}/collections`, ...qdrantProbe };
      }
      if (voiceHealthUrl && voiceHealthProbe) {
        services.voice = { url: voiceHealthUrl, ...voiceHealthProbe };
      }
      if (sttHealthUrl && sttProbe) {
        services.stt = { url: sttHealthUrl, ...sttProbe };
      }
      if (ttsHealthUrl && ttsProbe) {
        services.tts = { url: ttsHealthUrl, ...ttsProbe };
      }

      const computeHealthy = Boolean(routerProbe?.healthy || ollamaProbe?.healthy);
      const active = computeHealthy;
      const voiceAvailable = Boolean(
        (voiceHealthProbe?.healthy && voiceHealthProbe?.stt && voiceHealthProbe?.tts) ||
        (sttProbe?.healthy && ttsProbe?.healthy),
      );

      const payload = {
        enabled: true,
        active,
        host: host ?? null,
        checkedAt,
        voiceAvailable,
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
