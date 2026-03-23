import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type RoutingEvent = {
  access_mode?: unknown;
  backend?: unknown;
  fallback_hop?: unknown;
  endpoint_id?: unknown;
  model?: unknown;
  selection_reason?: unknown;
  reason?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBooleanLike(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readDgxConfig(config: OpenClawConfig) {
  const raw = (config as { dgx?: unknown }).dgx;
  const rec = asRecord(raw);
  return {
    accessMode:
      asNonEmptyString(rec?.accessMode) ??
      asNonEmptyString(rec?.access_mode) ??
      asNonEmptyString(process.env.DGX_ACCESS_MODE) ??
      "auto",
    wanBaseUrl: asNonEmptyString(rec?.wanBaseUrl),
    host: asNonEmptyString(process.env.DGX_HOST) ?? null,
    wanKillSwitch:
      typeof rec?.wanKillSwitch === "boolean"
        ? rec.wanKillSwitch
        : (parseBooleanLike(process.env.DGX_WAN_KILL_SWITCH) ?? false),
  };
}

function resolveRoutingLogPath(): string {
  const explicit = asNonEmptyString(process.env.OPENCLAW_ROUTER_METRICS_LOG);
  if (explicit) {
    return explicit;
  }
  const runtimeRoot = asNonEmptyString(process.env.OPENCLAW_RUNTIME_DIR);
  if (runtimeRoot) {
    return path.join(runtimeRoot, "tmp", "routing-decisions.jsonl");
  }
  return path.join(os.homedir(), ".openclaw", "tmp", "routing-decisions.jsonl");
}

function readLatestRoutingEvent(filePath: string): RoutingEvent | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as RoutingEvent;
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  } catch {
    return null;
  }
  return null;
}

function inferEndpointId(accessMode: string, backend: string): string {
  if (backend === "spark-private") {
    return accessMode === "wan" ? "dgx-wan" : "dgx";
  }
  if (backend === "mac-local") {
    return "mac";
  }
  if (backend === "cloud") {
    return "cloud";
  }
  return "unknown";
}

export const dgxRoutingHandlers: GatewayRequestHandlers = {
  "dgx.routing.status": async ({ respond }) => {
    try {
      const config = loadConfig();
      const dgx = readDgxConfig(config);
      const logPath = resolveRoutingLogPath();
      const latest = readLatestRoutingEvent(logPath);
      const configuredMode =
        dgx.accessMode === "lan" || dgx.accessMode === "wan" ? dgx.accessMode : "auto";
      const fallbackMode =
        configuredMode === "auto" ? (dgx.wanBaseUrl && !dgx.host ? "wan" : "lan") : configuredMode;
      const eventMode = asNonEmptyString(latest?.access_mode);
      const resolvedMode =
        dgx.wanKillSwitch && eventMode === "wan" ? fallbackMode : (eventMode ?? fallbackMode);
      const backend = asNonEmptyString(latest?.backend) ?? "unknown";
      const fallbackHop = Math.max(0, Math.floor(asNumber(latest?.fallback_hop) ?? 0));
      const endpointId =
        asNonEmptyString(latest?.endpoint_id) ?? inferEndpointId(resolvedMode, backend);
      const selectionReason =
        asNonEmptyString(latest?.selection_reason) ?? asNonEmptyString(latest?.reason) ?? null;

      respond(true, {
        checkedAt: Date.now(),
        configured_mode: configuredMode,
        access_mode: resolvedMode,
        backend,
        fallback_hop: fallbackHop,
        endpoint_id: endpointId,
        wanKillSwitch: dgx.wanKillSwitch,
        model: asNonEmptyString(latest?.model) ?? null,
        selection_reason: selectionReason,
        logPath,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
