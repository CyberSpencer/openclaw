import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  appendUrlPath,
  mergeDgxRequestHeaders,
  parseStringLike,
  resolveDgxAccess,
  resolveDgxEnabled,
  resolveEffectiveEnv,
  resolveWanServiceBaseUrl,
} from "./dgx-access.js";

const DEFAULT_PERSONAPLEX_PORT = 8998;

function resolvePort(env: Record<string, string>): number {
  const raw = parseStringLike(env.DGX_PERSONAPLEX_PORT) ?? parseStringLike(env.PERSONAPLEX_PORT);
  if (raw) {
    const port = Number(raw);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }
  return DEFAULT_PERSONAPLEX_PORT;
}

async function probePersonaPlexHealth(
  url: string,
  headers: Record<string, string>,
): Promise<{
  running: boolean;
  status?: number;
  error?: string;
}> {
  const timeoutMs = 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return {
      running: response.ok,
      status: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      running: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const personaplexStatusHandlers: GatewayRequestHandlers = {
  "voice.personaplex.status": async ({ respond }) => {
    try {
      const env = resolveEffectiveEnv();
      const enabled = resolveDgxEnabled(env);
      const port = resolvePort(env);
      if (!enabled) {
        respond(true, {
          enabled: false,
          installed: false,
          running: false,
          hasToken: false,
          port,
        });
        return;
      }

      const access = await resolveDgxAccess(env);
      if (!access.context) {
        respond(true, {
          enabled: true,
          installed: true,
          running: false,
          hasToken: Boolean(parseStringLike(process.env.HF_TOKEN)),
          port,
          error: access.error ?? "DGX endpoint is not configured",
        });
        return;
      }

      const url =
        access.context.mode === "wan"
          ? (() => {
              const base = resolveWanServiceBaseUrl(access.context, "personaplex");
              return base ? appendUrlPath(base, "health") : null;
            })()
          : access.context.lanHost
            ? `http://${access.context.lanHost}:${port}/health`
            : null;
      if (!url) {
        respond(true, {
          enabled: true,
          installed: true,
          running: false,
          hasToken: Boolean(parseStringLike(process.env.HF_TOKEN)),
          port,
          error: "PersonaPlex endpoint is not configured",
        });
        return;
      }

      const probe = await probePersonaPlexHealth(
        url,
        mergeDgxRequestHeaders(access.context, { accept: "application/json" }),
      );

      respond(true, {
        enabled,
        installed: true,
        running: probe.running,
        hasToken: Boolean(parseStringLike(process.env.HF_TOKEN)),
        port,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
