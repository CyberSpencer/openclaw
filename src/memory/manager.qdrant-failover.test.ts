import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery,
      embedBatch,
    },
  }),
}));

function makeConfig(
  workspaceDir: string,
  indexPath: string,
  qdrantEndpoints: Array<Record<string, unknown>>,
) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: {
            driver: "auto",
            path: indexPath,
            qdrant: {
              url: "http://127.0.0.1:6333",
              collection: "jarvis_memory_chunks",
              endpoints: qdrantEndpoints,
            },
            vector: { enabled: false },
          },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0 },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("memory manager qdrant failover", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qdrant-failover-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-02-07.md"), "hello\n");
    embedBatch.mockClear();
    embedQuery.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("uses secondary healthy qdrant endpoint when DGX endpoint fails health check", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("19001")) {
        return new Response("", { status: 503 });
      }
      if (url.includes("19002")) {
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const cfg = makeConfig(workspaceDir, indexPath, [
      {
        url: "http://127.0.0.1:19001",
        priority: 0,
        healthUrl: "http://127.0.0.1:19001/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
      {
        url: "http://127.0.0.1:19002",
        priority: 10,
        healthUrl: "http://127.0.0.1:19002/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
    ]);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const status = manager.status();
    expect(status.dbPath).toContain(
      "qdrant:http://127.0.0.1:19002/collections/jarvis_memory_chunks",
    );
  });

  it("propagates endpoint headers to qdrant health and query requests", async () => {
    const observedHeaders: Array<Record<string, string>> = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes("19101")) {
        observedHeaders.push(headers);
      }
      if (url.includes("19101") && url.includes("/points/search")) {
        return new Response(
          JSON.stringify({
            result: [
              {
                id: "point-1",
                score: 0.91,
                payload: {
                  text: "hello",
                  path: "memory/2026-02-07.md",
                  source: "memory",
                  start_line: 1,
                  end_line: 1,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("19101/collections") || url.includes("19102/collections")) {
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const cfg = makeConfig(workspaceDir, indexPath, [
      {
        url: "http://127.0.0.1:19101",
        priority: 0,
        headers: {
          "X-OpenClaw-Token": "wan-token",
          "ngrok-skip-browser-warning": "true",
        },
        healthUrl: "http://127.0.0.1:19101/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
      {
        url: "http://127.0.0.1:19102",
        priority: 5,
        healthUrl: "http://127.0.0.1:19102/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
    ]);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const rows = await manager.search("hello", { maxResults: 1, minScore: 0 });
    expect(rows).toHaveLength(1);

    expect(observedHeaders.length).toBeGreaterThan(0);
    for (const headers of observedHeaders) {
      expect(headers["X-OpenClaw-Token"]).toBe("wan-token");
      expect(headers["ngrok-skip-browser-warning"]).toBe("true");
    }
  });

  it("falls back to sqlite when all qdrant endpoints are unavailable", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("endpoint unavailable");
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const cfg = makeConfig(workspaceDir, indexPath, [
      {
        url: "http://127.0.0.1:29001",
        priority: 0,
        healthUrl: "http://127.0.0.1:29001/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
      {
        url: "http://127.0.0.1:29002",
        priority: 10,
        healthUrl: "http://127.0.0.1:29002/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
    ]);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const status = manager.status();
    expect(status.dbPath).toBe(indexPath);
  });

  it("does not fail over on non-retryable qdrant errors", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("19001") && url.includes("/points/search")) {
        return new Response("invalid query", { status: 400 });
      }
      if (url.includes("19002") && url.includes("/points/search")) {
        return new Response(
          JSON.stringify({
            result: [
              {
                id: "point-2",
                score: 0.77,
                payload: {
                  text: "unexpected",
                  path: "memory/unexpected.md",
                  source: "memory",
                  start_line: 1,
                  end_line: 1,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("19001/collections") || url.includes("19002/collections")) {
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const cfg = makeConfig(workspaceDir, indexPath, [
      {
        url: "http://127.0.0.1:19001",
        priority: 0,
        healthUrl: "http://127.0.0.1:19001/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
      {
        url: "http://127.0.0.1:19002",
        priority: 10,
        healthUrl: "http://127.0.0.1:19002/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
    ]);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const searchResults = await manager.search("hello", { maxResults: 1, minScore: 0 });
    expect(searchResults).toEqual([]);

    const secondarySearchCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = String(input);
      return url.includes("19002") && url.includes("/points/search");
    });
    expect(secondarySearchCalls).toHaveLength(0);
  });

  it("fails over from primary to secondary qdrant endpoint when requests fail after startup", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("19001") && url.includes("/points/search")) {
        return new Response("busy", { status: 503 });
      }
      if (url.includes("19002") && url.includes("/points/search")) {
        return new Response(
          JSON.stringify({
            result: [
              {
                id: "point-1",
                score: 0.99,
                payload: {
                  text: "hello",
                  path: "memory/2026-02-07.md",
                  source: "memory",
                  start_line: 1,
                  end_line: 1,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("19001/collections")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("19002/collections")) {
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const cfg = makeConfig(workspaceDir, indexPath, [
      {
        url: "http://127.0.0.1:19001",
        priority: 0,
        healthUrl: "http://127.0.0.1:19001/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
      {
        url: "http://127.0.0.1:19002",
        priority: 10,
        healthUrl: "http://127.0.0.1:19002/collections",
        healthTimeoutMs: 200,
        healthCacheTtlMs: 0,
      },
    ]);

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    const searchResults = await manager.search("hello", { maxResults: 1, minScore: 0 });
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.path).toBe("memory/2026-02-07.md");

    const status = manager.status();
    expect(status.dbPath).toContain(
      "qdrant:http://127.0.0.1:19002/collections/jarvis_memory_chunks",
    );
  });
});
