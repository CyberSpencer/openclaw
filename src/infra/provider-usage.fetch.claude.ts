import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
};

type ClaudeWebOrganizationsResponse = Array<{
  uuid?: string;
  name?: string;
}>;

type ClaudeWebUsageResponse = ClaudeUsageResponse;

function buildClaudeUsageWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
    });
  }

  if (data.seven_day_sonnet?.utilization !== undefined) {
    windows.push({
      label: "Sonnet week",
      usedPercent: clampPercent(data.seven_day_sonnet.utilization),
    });
  }

  if (data.seven_day_opus?.utilization !== undefined) {
    windows.push({
      label: "Opus week",
      usedPercent: clampPercent(data.seven_day_opus.utilization),
    });
  }

  return windows;
}

function resolveClaudeWebSessionKey(): string | undefined {
  const direct =
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }

  const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) {
    return undefined;
  }
  const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

async function fetchClaudeWebUsage(
  sessionKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot | null> {
  const headers: Record<string, string> = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJson(
    "https://claude.ai/api/organizations",
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!orgRes.ok) {
    return null;
  }

  const orgs = (await orgRes.json()) as ClaudeWebOrganizationsResponse;
  const orgId = orgs?.[0]?.uuid?.trim();
  if (!orgId) {
    return null;
  }

  const usageRes = await fetchJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!usageRes.ok) {
    return null;
  }

  const data = (await usageRes.json()) as ClaudeWebUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  if (windows.length === 0) {
    return null;
  }
  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    notes: ["via claude.ai web session"],
  };
}

export async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "openclaw",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    let message: string | undefined;
    try {
      const data = (await res.json()) as {
        error?: { message?: unknown } | null;
      };
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    // Claude Code CLI setup-token yields tokens that can be used for inference, but may not
    // include user:profile scope required by the OAuth usage endpoint. When a claude.ai
    // browser sessionKey is available, fall back to the web API.
    //
    // Also fall back on 429 (rate limited on the OAuth usage endpoint) — the web API
    // uses a different quota so it may still respond successfully.
    const shouldTryWebFallback =
      (res.status === 403 && message?.includes("scope requirement user:profile")) ||
      res.status === 429;
    if (shouldTryWebFallback) {
      // Try the OAuth token itself first — claude.ai accepts sk-ant-... tokens as session keys
      if (token.startsWith("sk-ant-")) {
        const web = await fetchClaudeWebUsage(token, timeoutMs, fetchFn);
        if (web) {
          return web;
        }
      }
      // Fall back to any explicitly configured web session key
      const sessionKey = resolveClaudeWebSessionKey();
      if (sessionKey && sessionKey !== token) {
        const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
        if (web) {
          return web;
        }
      }
    }

    // For rate limit errors, return a cleaner message without the full HTTP body
    if (res.status === 429) {
      return buildUsageErrorSnapshot("anthropic", "Rate limited");
    }

    // 403 scope errors are a known limitation of CLI-provisioned tokens — suppress
    // the raw HTTP error so no misleading chip is shown in the UI.
    if (res.status === 403 && message?.includes("scope requirement user:profile")) {
      return buildUsageErrorSnapshot("anthropic", "No token");
    }

    return buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: res.status,
      message,
    });
  }

  const data = (await res.json()) as ClaudeUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}
