import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveFetch } from "../../infra/fetch.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return null;
  }
  return v as Record<string, unknown>;
}

function readRouterBase(config: OpenClawConfig): { base: string; host: string } {
  const explicit = process.env.NVIDIA_ROUTER_URL?.trim() || process.env.ROUTER_URL?.trim();
  if (explicit) {
    return { base: explicit.replace(/\/$/, ""), host: "" };
  }
  const host = process.env.DGX_HOST?.trim() || "127.0.0.1";
  const portRaw =
    process.env.NVIDIA_ROUTER_PORT?.trim() ||
    process.env.ROUTER_PORT?.trim() ||
    process.env.DGX_ROUTER_PORT?.trim() ||
    "8001";
  const port = Number.parseInt(portRaw, 10);
  const portSafe = Number.isFinite(port) && port > 0 ? port : 8001;
  const raw = (config as { dgx?: unknown }).dgx;
  const rec = asRecord(raw);
  const fromConfig =
    typeof rec?.routerBaseUrl === "string" ? rec.routerBaseUrl.trim().replace(/\/$/, "") : "";
  if (fromConfig) {
    return { base: fromConfig, host };
  }
  return { base: `http://${host}:${portSafe}`, host };
}

type HealthProbeResult = {
  healthy: boolean;
  status?: number;
  error?: string;
};

async function fetchHealth(url: string, timeoutMs: number): Promise<HealthProbeResult> {
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    return { healthy: false, error: "fetch unavailable" };
  }
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: "GET", signal: ctrl.signal });
    const base: HealthProbeResult = {
      healthy: res.ok,
      status: res.status,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
    if (!res.ok) {
      return base;
    }

    let parsed: unknown = null;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      return base;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }

    const record = parsed as Record<string, unknown>;
    const rawStatus = record.status ?? record.value;
    const statusText = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (!statusText) {
      return base;
    }
    if (statusText === "healthy" || statusText === "ok") {
      return { healthy: true, status: res.status };
    }
    if (statusText === "degraded") {
      return {
        healthy: false,
        status: res.status,
        error: reason ? `degraded: ${reason}` : "degraded",
      };
    }
    return {
      healthy: false,
      status: res.status,
      error: reason ? `status=${statusText}: ${reason}` : `status=${statusText}`,
    };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(id);
  }
}

export const nvidiaRouterHandlers: GatewayRequestHandlers = {
  "router.status": async ({ respond }) => {
    const checkedAt = Date.now();
    const disabled =
      process.env.NVIDIA_ROUTER_DISABLED?.trim() === "1" ||
      process.env.NVIDIA_ROUTER_DISABLED?.trim().toLowerCase() === "true";
    if (disabled) {
      respond(true, {
        enabled: false,
        healthy: false,
        url: "",
        checkedAt,
      });
      return;
    }
    const config = loadConfig();
    const { base } = readRouterBase(config);
    const healthUrl = `${base}/health`;
    const probe = await fetchHealth(healthUrl, 4000);
    respond(
      true,
      {
        enabled: true,
        healthy: probe.healthy,
        url: healthUrl,
        checkedAt,
        status: probe.status,
        error: probe.error,
      },
      undefined,
    );
  },
  "router.setEnabled": async ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "router.setEnabled is not supported on the gateway. Enable or disable the NVIDIA router service on the DGX host (or set NVIDIA_ROUTER_DISABLED=1 on this machine).",
      ),
    );
  },
};
