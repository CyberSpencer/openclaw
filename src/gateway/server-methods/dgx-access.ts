import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type DgxAccessMode = "auto" | "lan" | "wan";
export type DgxServiceName =
  | "ollama"
  | "router"
  | "qdrant"
  | "embeddings"
  | "personaplex"
  | "moshi"
  | "voiceHealth"
  | "voiceStt"
  | "voiceTts"
  | "dashboard";

export type DgxAccessContext = {
  mode: "lan" | "wan";
  host: string | null;
  lanHost: string | null;
  wanBaseUrl: string | null;
  requestHeaders: Record<string, string>;
};

export type DgxAccessResolution = {
  context: DgxAccessContext | null;
  error?: string;
};

const DEFAULT_LAN_PROBE_TIMEOUT_MS = 800;
const DEFAULT_ACCESS_CACHE_TTL_MS = 5000;

const WAN_PATHS: Record<DgxServiceName, string> = {
  ollama: "ollama",
  router: "router",
  qdrant: "qdrant",
  embeddings: "embeddings",
  personaplex: "personaplex",
  moshi: "moshi",
  voiceHealth: "voice-health",
  voiceStt: "voice-stt",
  voiceTts: "voice-tts",
  dashboard: "dashboard",
};

let cachedAccess: {
  key: string;
  at: number;
  resolution: DgxAccessResolution;
} | null = null;

export function parseBooleanLike(raw: string | undefined): boolean | undefined {
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

export function parseStringLike(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  return unquoted.trim() || undefined;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function appendUrlPath(baseUrl: string, pathname: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = pathname.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

export function resolveContractPath(): string | null {
  const explicit = process.env.OPENCLAW_CONTRACT?.trim();
  if (explicit) {
    return explicit;
  }
  const fallback = path.resolve(process.cwd(), "config", "workspace.env");
  return existsSync(fallback) ? fallback : null;
}

export function readContractEnv(contractPath: string | null): Record<string, string> {
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
      result[key] = trimmed.slice(idx + 1).trim();
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveEffectiveEnv(): Record<string, string> {
  const merged = readContractEnv(resolveContractPath());
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  return merged;
}

export function resolveDgxEnabled(env: Record<string, string>): boolean {
  return Boolean(parseBooleanLike(env.DGX_ENABLED) ?? parseBooleanLike(process.env.DGX_ENABLED));
}

export function resolveDgxHost(env: Record<string, string>): string | undefined {
  return parseStringLike(env.DGX_HOST) ?? parseStringLike(process.env.DGX_HOST);
}

export function resolveDgxAccessMode(env: Record<string, string>): DgxAccessMode {
  const raw =
    parseStringLike(env.DGX_ACCESS_MODE) ?? parseStringLike(process.env.DGX_ACCESS_MODE) ?? "auto";
  const normalized = raw.toLowerCase();
  if (normalized === "lan" || normalized === "wan") {
    return normalized;
  }
  return "auto";
}

export function resolveWanBaseUrlFromEnv(env: Record<string, string>): string | undefined {
  const candidate =
    parseStringLike(env.DGX_WAN_BASE_URL) ??
    parseStringLike(process.env.DGX_WAN_BASE_URL) ??
    parseStringLike(env.OPENCLAW_WAN_BASE_URL) ??
    parseStringLike(process.env.OPENCLAW_WAN_BASE_URL);
  if (!candidate) {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    return normalizeBaseUrl(parsed.toString());
  } catch {
    return undefined;
  }
}

export function resolveWanSkipBrowserWarningHeader(env: Record<string, string>): boolean {
  const fromEnv =
    parseBooleanLike(env.DGX_WAN_SKIP_BROWSER_WARNING) ??
    parseBooleanLike(process.env.DGX_WAN_SKIP_BROWSER_WARNING);
  // Default enabled so free-tier ngrok interstitial does not break JSON APIs.
  return fromEnv ?? true;
}

function resolveLanProbeTimeoutMs(env: Record<string, string>): number {
  const raw =
    parseStringLike(env.DGX_LAN_PROBE_TIMEOUT_MS) ??
    parseStringLike(process.env.DGX_LAN_PROBE_TIMEOUT_MS);
  const parsed = raw ? Number(raw) : DEFAULT_LAN_PROBE_TIMEOUT_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LAN_PROBE_TIMEOUT_MS;
}

function resolveAccessCacheTtlMs(env: Record<string, string>): number {
  const raw =
    parseStringLike(env.DGX_ACCESS_CACHE_TTL_MS) ??
    parseStringLike(process.env.DGX_ACCESS_CACHE_TTL_MS);
  const parsed = raw ? Number(raw) : DEFAULT_ACCESS_CACHE_TTL_MS;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ACCESS_CACHE_TTL_MS;
}

function resolveRouterPortForLanProbe(env: Record<string, string>): number {
  const explicitRouterUrl =
    parseStringLike(env.DGX_ROUTER_URL) ??
    parseStringLike(process.env.DGX_ROUTER_URL) ??
    parseStringLike(env.OPENCLAW_NVIDIA_ROUTER_URL) ??
    parseStringLike(process.env.OPENCLAW_NVIDIA_ROUTER_URL);
  if (explicitRouterUrl) {
    try {
      const parsed = new URL(explicitRouterUrl);
      if (parsed.port) {
        const port = Number(parsed.port);
        if (Number.isFinite(port) && port > 0) {
          return port;
        }
      }
    } catch {
      // Ignore malformed URLs and fall back to default.
    }
  }
  return 8001;
}

function lanProbeHealthUrl(env: Record<string, string>, host: string): string {
  const port = resolveRouterPortForLanProbe(env);
  return `http://${host}:${port}/health`;
}

async function probeLanHealth(
  env: Record<string, string>,
  host: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const timeoutMs = resolveLanProbeTimeoutMs(env);
  const url = lanProbeHealthUrl(env, host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveNgrokApiUrl(env: Record<string, string>, host: string): string {
  const explicit =
    parseStringLike(env.DGX_NGROK_API_URL) ?? parseStringLike(process.env.DGX_NGROK_API_URL);
  if (explicit) {
    try {
      return new URL(explicit).toString();
    } catch {
      // Ignore invalid override.
    }
  }
  return `http://${host}:4040/api/tunnels`;
}

type NgrokTunnelResponse = {
  tunnels?: Array<{ public_url?: unknown }>;
};

async function discoverWanBaseUrl(
  env: Record<string, string>,
  host: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const shouldDiscover =
    parseBooleanLike(env.DGX_WAN_AUTO_DISCOVER) ??
    parseBooleanLike(process.env.DGX_WAN_AUTO_DISCOVER) ??
    true;
  if (!shouldDiscover) {
    return undefined;
  }

  const url = resolveNgrokApiUrl(env, host);
  const timeoutMs = resolveLanProbeTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as NgrokTunnelResponse;
    for (const tunnel of data.tunnels ?? []) {
      if (typeof tunnel?.public_url !== "string") {
        continue;
      }
      const candidate = tunnel.public_url.trim();
      if (!candidate.startsWith("https://")) {
        continue;
      }
      return normalizeBaseUrl(candidate);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function buildCacheKey(env: Record<string, string>): string {
  return [
    resolveDgxAccessMode(env),
    resolveDgxHost(env) ?? "",
    resolveWanBaseUrlFromEnv(env) ?? "",
    parseStringLike(env.DGX_ROUTER_URL) ?? "",
    parseStringLike(env.OPENCLAW_NVIDIA_ROUTER_URL) ?? "",
    parseStringLike(env.DGX_LAN_PROBE_TIMEOUT_MS) ?? "",
    parseStringLike(env.DGX_WAN_AUTO_DISCOVER) ?? "",
    parseStringLike(env.DGX_WAN_SKIP_BROWSER_WARNING) ?? "",
  ].join("|");
}

function resolveWanHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function buildWanHeaders(env: Record<string, string>): Record<string, string> {
  if (!resolveWanSkipBrowserWarningHeader(env)) {
    return {};
  }
  return { "ngrok-skip-browser-warning": "true" };
}

export async function resolveDgxAccess(
  env: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<DgxAccessResolution> {
  const ttlMs = resolveAccessCacheTtlMs(env);
  const key = buildCacheKey(env);
  const now = Date.now();
  if (cachedAccess && cachedAccess.key === key && now - cachedAccess.at < ttlMs) {
    return cachedAccess.resolution;
  }

  const mode = resolveDgxAccessMode(env);
  const lanHost = resolveDgxHost(env) ?? null;
  let wanBaseUrl = resolveWanBaseUrlFromEnv(env);

  if (!wanBaseUrl && lanHost && mode !== "lan") {
    wanBaseUrl = await discoverWanBaseUrl(env, lanHost, fetchImpl);
  }

  let resolution: DgxAccessResolution;
  if (mode === "lan") {
    if (!lanHost) {
      resolution = { context: null, error: "DGX_ACCESS_MODE=lan but DGX_HOST is not configured" };
    } else {
      resolution = {
        context: {
          mode: "lan",
          host: lanHost,
          lanHost,
          wanBaseUrl: null,
          requestHeaders: {},
        },
      };
    }
  } else if (mode === "wan") {
    if (!wanBaseUrl) {
      resolution = {
        context: null,
        error: "DGX_ACCESS_MODE=wan but DGX_WAN_BASE_URL is not configured (or invalid)",
      };
    } else {
      resolution = {
        context: {
          mode: "wan",
          host: resolveWanHost(wanBaseUrl),
          lanHost,
          wanBaseUrl,
          requestHeaders: buildWanHeaders(env),
        },
      };
    }
  } else {
    // auto mode: prefer LAN when reachable, otherwise WAN when available.
    const lanReachable = lanHost ? await probeLanHealth(env, lanHost, fetchImpl) : false;
    if (lanHost && lanReachable) {
      resolution = {
        context: {
          mode: "lan",
          host: lanHost,
          lanHost,
          wanBaseUrl,
          requestHeaders: {},
        },
      };
    } else if (wanBaseUrl) {
      resolution = {
        context: {
          mode: "wan",
          host: resolveWanHost(wanBaseUrl),
          lanHost,
          wanBaseUrl,
          requestHeaders: buildWanHeaders(env),
        },
      };
    } else if (lanHost) {
      // Backward-compatible fallback if WAN is not configured.
      resolution = {
        context: {
          mode: "lan",
          host: lanHost,
          lanHost,
          wanBaseUrl: null,
          requestHeaders: {},
        },
      };
    } else {
      resolution = { context: null, error: "DGX endpoints are not configured" };
    }
  }

  cachedAccess = { key, at: now, resolution };
  return resolution;
}

export function resolveWanServiceBaseUrl(
  context: DgxAccessContext | null,
  service: DgxServiceName,
): string | undefined {
  if (!context || context.mode !== "wan" || !context.wanBaseUrl) {
    return undefined;
  }
  return appendUrlPath(context.wanBaseUrl, `${WAN_PATHS[service]}/`);
}

export function mergeDgxRequestHeaders(
  context: DgxAccessContext | null,
  baseHeaders: Record<string, string>,
): Record<string, string> {
  if (!context || context.mode !== "wan") {
    return { ...baseHeaders };
  }
  return { ...baseHeaders, ...context.requestHeaders };
}
