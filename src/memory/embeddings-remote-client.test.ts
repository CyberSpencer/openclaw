import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProvider = vi.fn();
const requireApiKey = vi.fn((auth: { apiKey?: string }, provider: string) => {
  if (auth.apiKey?.trim()) {
    return auth.apiKey;
  }
  throw new Error(`No API key resolved for provider "${provider}".`);
});

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
  requireApiKey,
}));

describe("resolveRemoteEmbeddingBearerClient", () => {
  beforeEach(() => {
    resolveApiKeyForProvider.mockReset();
    requireApiKey.mockClear();
  });

  it("supports header-only remote auth when explicit remote headers are provided", async () => {
    resolveApiKeyForProvider.mockRejectedValueOnce(
      new Error('No API key found for provider "openai".'),
    );
    const { resolveRemoteEmbeddingBearerClient } = await import("./embeddings-remote-client.js");

    const result = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {},
        provider: "openai",
        model: "text-embedding-3-small",
        fallback: "none",
        remote: {
          baseUrl: "https://spark-wan.example/embeddings/v1",
          headers: {
            "X-OpenClaw-Token": "wan-token",
            "ngrok-skip-browser-warning": "true",
          },
        },
      },
    });

    expect(result.baseUrl).toBe("https://spark-wan.example/embeddings/v1");
    expect(result.headers).toEqual({
      "Content-Type": "application/json",
      "X-OpenClaw-Token": "wan-token",
      "ngrok-skip-browser-warning": "true",
    });
    expect(result.headers.Authorization).toBeUndefined();
  });

  it("still sends bearer auth when a provider key resolves alongside explicit headers", async () => {
    resolveApiKeyForProvider.mockResolvedValueOnce({
      apiKey: "provider-key",
      source: "env: OPENAI_API_KEY",
      mode: "api-key",
    });
    const { resolveRemoteEmbeddingBearerClient } = await import("./embeddings-remote-client.js");

    const result = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {},
        provider: "openai",
        model: "text-embedding-3-small",
        fallback: "none",
        remote: {
          headers: {
            "X-Trace": "1",
          },
        },
      },
    });

    expect(result.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer provider-key",
      "X-Trace": "1",
    });
  });

  it("allows authless private LAN remote embeddings without explicit headers", async () => {
    resolveApiKeyForProvider.mockRejectedValueOnce(
      new Error('No API key found for provider "openai".'),
    );
    const { resolveRemoteEmbeddingBearerClient } = await import("./embeddings-remote-client.js");

    const result = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {},
        provider: "openai",
        model: "Qwen3-Embedding-8B",
        fallback: "none",
        remote: {
          baseUrl: "http://192.168.1.93:8081/v1",
        },
      },
    });

    expect(result.baseUrl).toBe("http://192.168.1.93:8081/v1");
    expect(result.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("still requires bearer auth when no explicit remote headers are provided for public endpoints", async () => {
    resolveApiKeyForProvider.mockRejectedValueOnce(
      new Error('No API key found for provider "openai".'),
    );
    const { resolveRemoteEmbeddingBearerClient } = await import("./embeddings-remote-client.js");

    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: {},
          provider: "openai",
          model: "text-embedding-3-small",
          fallback: "none",
          remote: {
            baseUrl: "https://api.openai.com/v1",
          },
        },
      }),
    ).rejects.toThrow('No API key found for provider "openai".');
  });
});
