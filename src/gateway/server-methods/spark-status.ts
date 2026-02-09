import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_QDRANT_PORT = 6333;

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

      const services: Record<string, unknown> = {};

      const routerUrl = resolveRouterUrl(env);
      const routerHealth = routerUrl ? deriveRouterHealthUrl(routerUrl) : null;
      const ollamaUrl = resolveOllamaUrl(env);
      const qdrantUrl = resolveQdrantUrl(env);

      const [routerProbe, ollamaProbe, qdrantProbe] = await Promise.all([
        routerHealth ? probeHealth(routerHealth) : Promise.resolve(null),
        ollamaUrl ? probeHealth(`${normalizeBaseUrl(ollamaUrl)}/api/tags`) : Promise.resolve(null),
        qdrantUrl
          ? probeHealth(`${normalizeBaseUrl(qdrantUrl)}/collections`)
          : Promise.resolve(null),
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

      const computeHealthy = Boolean(routerProbe?.healthy || ollamaProbe?.healthy);
      const active = computeHealthy;

      const payload = {
        enabled: true,
        active,
        host: host ?? null,
        checkedAt,
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
