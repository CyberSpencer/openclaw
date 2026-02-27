import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRerankClient } from "./reranker.js";

function makeConfig(overrides?: {
  endpoints?: Array<Record<string, unknown>>;
  timeoutMs?: number;
}) {
  return {
    enabled: true,
    candidateLimit: 20,
    topN: 0,
    failOpen: true,
    timeoutMs: overrides?.timeoutMs ?? 500,
    remote: {
      endpoints: (overrides?.endpoints ?? [
        {
          baseUrl: "http://lan:7999/reranker",
          priority: 0,
          healthUrl: "http://lan:7999/reranker/health",
          healthTimeoutMs: 200,
          healthCacheTtlMs: 10000,
        },
        {
          baseUrl: "https://wan.ngrok-free.dev/reranker",
          priority: 5,
          healthUrl: "https://wan.ngrok-free.dev/reranker/health",
          healthTimeoutMs: 200,
          healthCacheTtlMs: 10000,
          headers: {
            "X-OpenClaw-Token": "token",
            "ngrok-skip-browser-warning": "true",
          },
        },
      ]) as Array<{
        baseUrl: string;
        priority?: number;
        healthUrl?: string;
        healthTimeoutMs?: number;
        healthCacheTtlMs?: number;
        headers?: Record<string, string>;
      }>,
    },
  };
}

describe("memory reranker client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to WAN when LAN health is failing", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("http://lan:7999/reranker/health")) {
        return new Response("", { status: 503 });
      }
      if (url.includes("https://wan.ngrok-free.dev/reranker/health")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("https://wan.ngrok-free.dev/reranker/v1/rerank")) {
        return new Response(
          JSON.stringify({
            results: [
              { id: "doc-2", score: 0.9, rank: 1 },
              { id: "doc-1", score: 0.8, rank: 2 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const client = createMemoryRerankClient(makeConfig());
    expect(client).not.toBeNull();
    if (!client) {
      throw new Error("client missing");
    }

    const res = await client.rerank({
      query: "hello",
      documents: [
        { id: "doc-1", text: "one" },
        { id: "doc-2", text: "two" },
      ],
      topN: 2,
    });

    expect(res.ids).toEqual(["doc-2", "doc-1"]);
    expect(res.endpoint).toBe("https://wan.ngrok-free.dev/reranker");
    expect(res.fallbackUsed).toBe(true);
  });

  it("caches health checks within TTL", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/v1/rerank")) {
        return new Response(JSON.stringify({ results: [{ id: "doc-1", score: 0.7, rank: 1 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const client = createMemoryRerankClient(
      makeConfig({
        endpoints: [
          {
            baseUrl: "http://lan-cache:7999/reranker",
            priority: 0,
            healthUrl: "http://lan-cache:7999/reranker/health",
            healthCacheTtlMs: 60_000,
          },
        ],
      }),
    );
    expect(client).not.toBeNull();
    if (!client) {
      throw new Error("client missing");
    }

    await client.rerank({
      query: "q1",
      documents: [{ id: "doc-1", text: "one" }],
      topN: 1,
    });
    await client.rerank({
      query: "q2",
      documents: [{ id: "doc-1", text: "one" }],
      topN: 1,
    });

    const healthCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/health"));
    const rerankCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("/v1/rerank"),
    );
    expect(healthCalls).toHaveLength(1);
    expect(rerankCalls).toHaveLength(2);
  });

  it("fails over when primary rerank request errors", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("http://lan:7999/reranker/v1/rerank")) {
        throw new Error("timeout");
      }
      if (url.includes("https://wan.ngrok-free.dev/reranker/v1/rerank")) {
        return new Response(JSON.stringify({ results: [{ id: "doc-2", score: 0.7, rank: 1 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const client = createMemoryRerankClient(makeConfig({ timeoutMs: 100 }));
    expect(client).not.toBeNull();
    if (!client) {
      throw new Error("client missing");
    }

    const res = await client.rerank({
      query: "hello",
      documents: [
        { id: "doc-1", text: "one" },
        { id: "doc-2", text: "two" },
      ],
      topN: 2,
    });

    expect(res.endpoint).toBe("https://wan.ngrok-free.dev/reranker");
    expect(client.lastFallbackUsed).toBe(true);
  });
});
