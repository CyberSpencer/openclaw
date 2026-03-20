import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions, RespondFn as GatewayResponder } from "./types.js";

const loadConfigMock = vi.fn(() => ({}));
const ensureAuthProfileStoreMock = vi.fn();
const resolveEnvApiKeyMock = vi.fn();
const resolveApiKeyForProfileMock = vi.fn();
const loadCodexRateLimitSnapshotMock = vi.fn();
const buildCodexRateLimitSummaryMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    resolveApiKeyForProfile: resolveApiKeyForProfileMock,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: resolveEnvApiKeyMock,
}));

vi.mock("../../agents/codex-rate-limits.js", () => ({
  loadCodexRateLimitSnapshot: loadCodexRateLimitSnapshotMock,
  buildCodexRateLimitSummary: buildCodexRateLimitSummaryMock,
}));

function makeInvocation(
  respond: GatewayResponder,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "1", method: "models.authStatus", params },
    params,
    respond,
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
  };
}

describe("models.authStatus handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loadConfigMock.mockReset().mockReturnValue({});
    ensureAuthProfileStoreMock.mockReset();
    resolveEnvApiKeyMock.mockReset().mockReturnValue(undefined);
    resolveApiKeyForProfileMock.mockReset();
    loadCodexRateLimitSnapshotMock.mockReset().mockReturnValue(null);
    buildCodexRateLimitSummaryMock.mockReset().mockReturnValue({
      source: "codex-app-server",
      stale: true,
      status: "unavailable",
      buckets: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cooldown timing for blocked Codex OAuth profiles", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: now + 86_400_000,
        },
      },
      usageStats: {
        "openai-codex:default": {
          cooldownUntil: now + 300_000,
        },
      },
    });

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex" }),
    );

    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(undefined, {
      allowKeychainPrompt: false,
    });
    expect(loadCodexRateLimitSnapshotMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "openai-codex",
        status: "cooldown",
        nextRetryAt: now + 300_000,
        nextRetryKind: "cooldown",
        codexRateLimits: expect.objectContaining({
          source: "codex-app-server",
          status: "unavailable",
        }),
      }),
      undefined,
    );
  });

  it("reports ready when an OAuth env token is present", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    resolveEnvApiKeyMock.mockReturnValue({
      apiKey: "oauth-token",
      source: "env: OPENAI_OAUTH_TOKEN",
    });

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex" }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "openai-codex",
        status: "ready",
        source: "env",
      }),
      undefined,
    );
  });

  it("reports disabled when live Codex OAuth refresh fails permanently", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: now + 86_400_000,
        },
      },
    });
    resolveApiKeyForProfileMock.mockRejectedValue(
      new Error("OAuth token refresh failed: refresh_token_reused. Please try signing in again."),
    );

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex" }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "openai-codex",
        status: "disabled",
        nextRetryReason: "auth_permanent",
        readyProfileCount: 0,
        blockedProfileCount: 1,
      }),
      undefined,
    );
  });

  it("includes codex rate-limit summary for openai-codex", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    buildCodexRateLimitSummaryMock.mockReturnValue({
      source: "codex-app-server",
      checkedAt: 1_700_000_000_000,
      stale: false,
      status: "available",
      accountType: "chatgpt",
      planType: "pro",
      buckets: [
        {
          bucketId: "primary",
          source: "rateLimits",
          scope: "generic_codex",
          modelRefs: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.3-codex-spark"],
          usedPercent: 44,
          windowDurationMins: 300,
          resetsAt: 1_700_000_300_000,
          resetsInMs: 300_000,
        },
      ],
    });

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex" }),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "openai-codex",
        codexRateLimits: expect.objectContaining({
          status: "available",
          planType: "pro",
          buckets: [expect.objectContaining({ bucketId: "primary", usedPercent: 44 })],
        }),
      }),
      undefined,
    );
  });

  it("rejects unknown params", async () => {
    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex", extra: true }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringMatching(/invalid models\.authStatus params/i),
      }),
    );
  });
});
