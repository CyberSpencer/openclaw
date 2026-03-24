import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

function isLikelyPrivateRemoteBaseUrl(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) {
      return false;
    }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }
    if (host.endsWith(".local") || host.startsWith("10.") || host.startsWith("192.168.")) {
      return true;
    }
    const octets = host.split(".");
    if (octets.length === 4 && octets[0] === "172") {
      const second = Number(octets[1]);
      return Number.isInteger(second) && second >= 16 && second <= 31;
    }
    return false;
  } catch {
    return false;
  }
}

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const remote = params.options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || params.defaultBaseUrl;
  const explicitRemoteHeaders = Object.keys(remote?.headers ?? {}).length > 0;
  const allowAuthlessRemote = explicitRemoteHeaders || isLikelyPrivateRemoteBaseUrl(baseUrl);

  let apiKey = remoteApiKey || undefined;
  if (!apiKey) {
    try {
      apiKey = requireApiKey(
        await resolveApiKeyForProvider({
          provider: params.provider,
          cfg: params.options.config,
          agentDir: params.options.agentDir,
        }),
        params.provider,
      );
    } catch (err) {
      if (!allowAuthlessRemote) {
        throw err;
      }
    }
  }

  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...headerOverrides,
  };
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
