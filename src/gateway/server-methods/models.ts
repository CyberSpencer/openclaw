import { buildAuthProviderRecovery, DEFAULT_OAUTH_WARN_MS } from "../../agents/auth-health.js";
import { ensureAuthProfileStore, resolveApiKeyForProfile } from "../../agents/auth-profiles.js";
import type { AuthProfileFailureReason } from "../../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsAuthStatusParams,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function looksLikePermanentAuthFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("refresh_token_reused") ||
    normalized.includes("signing in again") ||
    normalized.includes("sign in again")
  );
}

async function resolveLiveProviderAuthFailure(params: {
  provider: string;
  cfg: ReturnType<typeof loadConfig>;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): Promise<AuthProfileFailureReason | null> {
  const profileIds = Object.entries(params.store.profiles)
    .filter(
      ([_, credential]) => credential.provider === params.provider && credential.type === "oauth",
    )
    .map(([profileId]) => profileId);

  if (profileIds.length === 0) {
    return null;
  }

  let sawAuthFailure = false;
  let sawPermanentAuthFailure = false;
  for (const profileId of profileIds) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg: params.cfg,
        store: params.store,
        profileId,
      });
      if (resolved?.apiKey) {
        return null;
      }
    } catch (error) {
      sawAuthFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      if (looksLikePermanentAuthFailure(message)) {
        sawPermanentAuthFailure = true;
      }
    }
  }

  if (sawPermanentAuthFailure) {
    return "auth_permanent";
  }
  return sawAuthFailure ? "auth" : null;
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.authStatus": async ({ params, respond }) => {
    if (!validateModelsAuthStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.authStatus params: ${formatValidationErrors(validateModelsAuthStatusParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const provider = params.provider.trim();
      const cfg = loadConfig();
      const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
      const envKey = resolveEnvApiKey(provider);
      const hasEnvOAuth = Boolean(
        envKey &&
        (envKey.source.includes("OAUTH_TOKEN") || envKey.source.toLowerCase().includes("oauth")),
      );
      const status = buildAuthProviderRecovery({
        provider,
        cfg,
        store,
        warnAfterMs: DEFAULT_OAUTH_WARN_MS,
        hasEnvOAuth,
      });
      if (!hasEnvOAuth && status.status === "ready" && status.source === "profiles") {
        const liveFailureReason = await resolveLiveProviderAuthFailure({
          provider,
          cfg,
          store,
        });
        if (liveFailureReason) {
          respond(
            true,
            {
              ...status,
              status: "disabled",
              readyProfileCount: 0,
              blockedProfileCount: Math.max(status.blockedProfileCount, status.profileCount),
              nextRetryAt: undefined,
              nextRetryInMs: undefined,
              nextRetryKind: undefined,
              nextRetryReason: liveFailureReason,
            },
            undefined,
          );
          return;
        }
      }
      respond(true, status, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
