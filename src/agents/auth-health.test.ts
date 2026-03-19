import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-profiles.js", () => ({
  resolveAuthProfileDisplayLabel: (params: { profileId: string }) => params.profileId,
  resolveProfileUnusableUntilForDisplay: (
    store: { usageStats?: Record<string, { disabledUntil?: number; cooldownUntil?: number }> },
    profileId: string,
  ) => {
    const usage = store.usageStats?.[profileId];
    const candidates = [usage?.disabledUntil, usage?.cooldownUntil].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (candidates.length === 0) {
      return undefined;
    }
    return Math.min(...candidates);
  },
}));
import {
  buildAuthHealthSummary,
  buildAuthProviderRecovery,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies OAuth and API key profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "anthropic:ok": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
        },
        "anthropic:expiring": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + 10_000,
        },
        "anthropic:expired": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now - 10_000,
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api",
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["anthropic:ok"]).toBe("ok");
    // OAuth credentials with refresh tokens are auto-renewable, so they report "ok"
    expect(statuses["anthropic:expiring"]).toBe("ok");
    expect(statuses["anthropic:expired"]).toBe("ok");
    expect(statuses["anthropic:api"]).toBe("static");

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("ok");
  });

  it("reports expired for OAuth without a refresh token", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "google:no-refresh": {
          type: "oauth" as const,
          provider: "google-antigravity",
          access: "access",
          refresh: "",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });

    const statuses = profileStatuses(summary);

    expect(statuses["google:no-refresh"]).toBe("expired");
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});

describe("buildAuthProviderRecovery", () => {
  const now = 1_700_000_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the earliest retry window for blocked OAuth profiles", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai-codex:cooldown": {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS,
        },
      },
      usageStats: {
        "openai-codex:cooldown": {
          cooldownUntil: now + 5 * 60_000,
        },
      },
    };

    const summary = buildAuthProviderRecovery({
      provider: "openai-codex",
      store,
    });

    expect(summary.status).toBe("cooldown");
    expect(summary.nextRetryAt).toBe(now + 5 * 60_000);
    expect(summary.nextRetryKind).toBe("cooldown");
    expect(summary.blockedProfileCount).toBe(1);
  });

  it("treats an env OAuth token as ready even when stored profiles are blocked", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai-codex:disabled": {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: now + DEFAULT_OAUTH_WARN_MS,
        },
      },
      usageStats: {
        "openai-codex:disabled": {
          disabledUntil: now + 60 * 60_000,
          disabledReason: "auth",
        },
      },
    };

    const summary = buildAuthProviderRecovery({
      provider: "openai-codex",
      store,
      hasEnvOAuth: true,
    });

    expect(summary.status).toBe("ready");
    expect(summary.source).toBe("env");
  });

  it("uses explicit now for classification boundaries", () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    const store = {
      version: 1,
      profiles: {
        "openai-codex:expiring": {
          type: "token" as const,
          provider: "openai-codex",
          token: "token",
          expires: now + 1,
        },
      },
    };

    const summary = buildAuthProviderRecovery({
      provider: "openai-codex",
      store,
      now,
    });

    expect(summary.checkedAt).toBe(now);
    expect(summary.status).toBe("ready");
    expect(summary.readyProfileCount).toBe(1);
    expect(summary.expiredProfileCount).toBe(0);
  });

  it("reports expired when no usable retryable OAuth credentials remain", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = {
      version: 1,
      profiles: {
        "openai-codex:expired": {
          type: "token" as const,
          provider: "openai-codex",
          token: "token",
          expires: now - 10_000,
        },
      },
    };

    const summary = buildAuthProviderRecovery({
      provider: "openai-codex",
      store,
    });

    expect(summary.status).toBe("expired");
    expect(summary.profileCount).toBe(1);
    expect(summary.expiredProfileCount).toBe(1);
  });
});
