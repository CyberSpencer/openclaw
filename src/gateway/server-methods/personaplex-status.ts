import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

const DEFAULT_PERSONAPLEX_PORT = 8998;

function parseStringLike(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  return unquoted.trim() || undefined;
}

function resolveDgxHost(): string | undefined {
  return parseStringLike(process.env.DGX_PERSONAPLEX_HOST) ?? parseStringLike(process.env.DGX_HOST);
}

function resolvePort(): number {
  const raw =
    parseStringLike(process.env.DGX_PERSONAPLEX_PORT) ??
    parseStringLike(process.env.PERSONAPLEX_PORT);
  if (raw) {
    const port = Number(raw);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }
  return DEFAULT_PERSONAPLEX_PORT;
}

async function probePersonaPlexHealth(
  host: string,
  port: number,
): Promise<{
  running: boolean;
  status?: number;
  error?: string;
}> {
  const url = `http://${host}:${port}/health`;
  const timeoutMs = 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
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
      const dgxHost = resolveDgxHost();
      const port = resolvePort();
      const enabled = Boolean(dgxHost);

      if (!dgxHost) {
        respond(true, {
          enabled: false,
          installed: false,
          running: false,
          hasToken: false,
          port,
        });
        return;
      }

      const probe = await probePersonaPlexHealth(dgxHost, port);

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
