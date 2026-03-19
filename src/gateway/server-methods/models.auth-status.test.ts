import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions, RespondFn as GatewayResponder } from "./types.js";

const loadConfigMock = vi.fn(() => ({}));
const buildAuthProviderRecoveryMock = vi.fn();
const ensureAuthProfileStoreMock = vi.fn();
const resolveEnvApiKeyMock = vi.fn();
const resolveApiKeyForProfileMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../agents/auth-health.js", () => ({
  buildAuthProviderRecovery: buildAuthProviderRecoveryMock,
  DEFAULT_OAUTH_WARN_MS: 86_400_000,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  resolveApiKeyForProfile: resolveApiKeyForProfileMock,
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: resolveEnvApiKeyMock,
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
    buildAuthProviderRecoveryMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    resolveEnvApiKeyMock.mockReset().mockReturnValue(undefined);
    resolveApiKeyForProfileMock.mockReset();
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
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "openai-codex",
      status: "cooldown",
      source: "profiles",
      profileCount: 1,
      readyProfileCount: 0,
      blockedProfileCount: 1,
      expiredProfileCount: 0,
      missingProfileCount: 0,
      nextRetryAt: now + 300_000,
      nextRetryInMs: 300_000,
      nextRetryKind: "cooldown",
    });

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(
      makeInvocation(respond, { provider: "openai-codex" }),
    );

    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(undefined, {
      allowKeychainPrompt: false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "openai-codex",
        status: "cooldown",
        nextRetryAt: now + 300_000,
        nextRetryKind: "cooldown",
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
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "openai-codex",
      status: "ready",
      source: "env",
      profileCount: 0,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      expiredProfileCount: 0,
      missingProfileCount: 0,
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
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "openai-codex",
      status: "ready",
      source: "profiles",
      profileCount: 1,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      expiredProfileCount: 0,
      missingProfileCount: 0,
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

  it("reports transient refresh failures as auth, not auth_permanent", async () => {
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
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "openai-codex",
      status: "ready",
      source: "profiles",
      profileCount: 1,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      expiredProfileCount: 0,
      missingProfileCount: 0,
    });
    resolveApiKeyForProfileMock.mockRejectedValue(
      new Error(
        "OAuth token refresh failed for openai-codex: upstream provider unavailable. Please try again or re-authenticate.",
      ),
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
        nextRetryReason: "auth",
        readyProfileCount: 0,
        blockedProfileCount: 1,
      }),
      undefined,
    );
  });

  it("keeps mixed-state profile counts partition-consistent when live probe downgrades readiness", async () => {
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
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "openai-codex",
      status: "ready",
      source: "profiles",
      profileCount: 2,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      expiredProfileCount: 1,
      missingProfileCount: 0,
    });
    resolveApiKeyForProfileMock.mockRejectedValue(new Error("OAuth token refresh failed"));

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
        readyProfileCount: 0,
        blockedProfileCount: 1,
        expiredProfileCount: 1,
        profileCount: 2,
      }),
      undefined,
    );
  });

  it("skips live probing for non-allowlisted providers", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: now + 86_400_000,
        },
      },
    });
    buildAuthProviderRecoveryMock.mockReturnValue({
      checkedAt: now,
      provider: "anthropic",
      status: "ready",
      source: "profiles",
      profileCount: 1,
      readyProfileCount: 1,
      blockedProfileCount: 0,
      expiredProfileCount: 0,
      missingProfileCount: 0,
    });

    const respond = vi.fn<GatewayResponder>();
    const { modelsHandlers } = await import("./models.js");
    await modelsHandlers["models.authStatus"]?.(makeInvocation(respond, { provider: "anthropic" }));

    expect(resolveApiKeyForProfileMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "anthropic",
        status: "ready",
        readyProfileCount: 1,
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
