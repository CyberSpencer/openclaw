import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  appendUrlPath,
  mergeDgxRequestHeaders,
  parseBooleanLike,
  parseStringLike,
  resolveDgxAccess,
  resolveDgxEnabled,
  resolveEffectiveEnv,
  resolveWanServiceBaseUrl,
} from "./dgx-access.js";

const DEFAULT_ROUTER_URL = "http://127.0.0.1:8001/sfc_router/chat/completions";
const DEFAULT_ROUTER_HEALTH_URL = "http://127.0.0.1:8001/health";
const ROUTER_DISABLED_KEY = "OPENCLAW_NVIDIA_ROUTER_DISABLED";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveContractPath(): string | null {
  const explicit = process.env.OPENCLAW_CONTRACT?.trim();
  if (explicit) {
    return explicit;
  }
  const fallback = path.resolve(process.cwd(), "config", "workspace.env");
  return existsSync(fallback) ? fallback : null;
}

function readRouterDisabledFromContract(contractPath: string | null): boolean | undefined {
  if (!contractPath || !existsSync(contractPath)) {
    return undefined;
  }
  try {
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
      if (key !== ROUTER_DISABLED_KEY) {
        continue;
      }
      return parseBooleanLike(trimmed.slice(idx + 1).trim());
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writeRouterDisabledToContract(contractPath: string | null, disabled: boolean): void {
  if (!contractPath) {
    return;
  }
  const line = `${ROUTER_DISABLED_KEY}=${disabled ? "1" : "0"}`;
  mkdirSync(path.dirname(contractPath), { recursive: true });
  if (!existsSync(contractPath)) {
    writeFileSync(contractPath, `${line}\n`, { encoding: "utf-8", mode: 0o600 });
    return;
  }
  const raw = readFileSync(contractPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return entry;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 0) {
      return entry;
    }
    const key = trimmed.slice(0, idx).trim();
    if (key !== ROUTER_DISABLED_KEY) {
      return entry;
    }
    replaced = true;
    return line;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push(line);
  }
  writeFileSync(contractPath, next.join("\n").replace(/\n*$/, "\n"), { encoding: "utf-8" });
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

function deriveRouterHealthUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return DEFAULT_ROUTER_HEALTH_URL;
  }
}

async function resolveRouterHealthTarget(): Promise<{
  url: string;
  headers: Record<string, string>;
  error?: string;
}> {
  const env = resolveEffectiveEnv();
  if (resolveDgxEnabled(env)) {
    const access = await resolveDgxAccess(env);
    if (access.context?.mode === "wan") {
      const base = resolveWanServiceBaseUrl(access.context, "router");
      if (base) {
        return {
          url: appendUrlPath(base, "health"),
          headers: mergeDgxRequestHeaders(access.context, { accept: "application/json" }),
        };
      }
      return {
        url: DEFAULT_ROUTER_HEALTH_URL,
        headers: { accept: "application/json" },
        error: access.error ?? "WAN router endpoint is not configured",
      };
    }

    const lanRouterUrl =
      resolveUrlFromEnv(env.DGX_ROUTER_URL ?? process.env.DGX_ROUTER_URL) ??
      resolveUrlFromEnv(env.OPENCLAW_NVIDIA_ROUTER_URL ?? process.env.OPENCLAW_NVIDIA_ROUTER_URL) ??
      (access.context?.lanHost
        ? `http://${access.context.lanHost}:8001/sfc_router/chat/completions`
        : undefined);
    if (lanRouterUrl) {
      return {
        url: deriveRouterHealthUrl(lanRouterUrl),
        headers: mergeDgxRequestHeaders(access.context ?? null, { accept: "application/json" }),
        error: access.error,
      };
    }
  }

  const configuredUrl =
    resolveUrlFromEnv(env.OPENCLAW_NVIDIA_ROUTER_URL ?? process.env.OPENCLAW_NVIDIA_ROUTER_URL) ??
    resolveUrlFromEnv(env.DGX_ROUTER_URL ?? process.env.DGX_ROUTER_URL) ??
    DEFAULT_ROUTER_URL;
  return {
    url: deriveRouterHealthUrl(configuredUrl),
    headers: { accept: "application/json" },
  };
}

async function probeHealth(
  url: string,
  headers: Record<string, string>,
): Promise<{
  healthy: boolean;
  status?: number;
  error?: string;
}> {
  const timeoutMs = 1500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
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
    clearTimeout(timeout);
  }
}

export const routerStatusHandlers: GatewayRequestHandlers = {
  "router.status": async ({ respond }) => {
    const target = await resolveRouterHealthTarget();
    const contractPath = resolveContractPath();
    const contractDisabled = readRouterDisabledFromContract(contractPath);
    const enabled = !(contractDisabled ?? envFlag(ROUTER_DISABLED_KEY));
    if (!enabled) {
      respond(
        true,
        {
          enabled: false,
          healthy: false,
          url: target.url,
          checkedAt: Date.now(),
          error: "disabled",
        },
        undefined,
      );
      return;
    }

    const probe = await probeHealth(target.url, target.headers);
    respond(
      true,
      {
        enabled: true,
        healthy: probe.healthy,
        url: target.url,
        checkedAt: Date.now(),
        status: probe.status,
        error: target.error ?? probe.error,
      },
      undefined,
    );
  },
  "router.setEnabled": async ({ respond, params }) => {
    const enabled = params?.enabled;
    if (typeof enabled !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "router.setEnabled requires boolean enabled"),
      );
      return;
    }
    const disabled = !enabled;
    process.env[ROUTER_DISABLED_KEY] = disabled ? "1" : "0";
    try {
      writeRouterDisabledToContract(resolveContractPath(), disabled);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const target = await resolveRouterHealthTarget();
    if (!enabled) {
      respond(
        true,
        {
          enabled: false,
          healthy: false,
          url: target.url,
          checkedAt: Date.now(),
          error: "disabled",
        },
        undefined,
      );
      return;
    }
    const probe = await probeHealth(target.url, target.headers);
    respond(
      true,
      {
        enabled: true,
        healthy: probe.healthy,
        url: target.url,
        checkedAt: Date.now(),
        status: probe.status,
        error: target.error ?? probe.error,
      },
      undefined,
    );
  },
};
