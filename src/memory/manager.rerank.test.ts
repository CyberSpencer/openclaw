import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0, 0]));
const embedQuery = vi.fn(async () => [0, 0]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "mock-embed",
      embedQuery,
      embedBatch,
    },
  }),
}));

function makeConfig(workspaceDir: string, indexPath: string, rerankEnabled: boolean) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: {
            driver: "sqlite",
            path: indexPath,
            vector: { enabled: false },
          },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: {
            minScore: 0,
            hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
          },
          rerank: {
            enabled: rerankEnabled,
            candidateLimit: 20,
            topN: 0,
            failOpen: true,
            timeoutMs: 500,
            remote: {
              endpoints: [
                {
                  baseUrl: "http://spark.lan:7999/reranker",
                  priority: 0,
                  healthUrl: "http://spark.lan:7999/reranker/health",
                  healthTimeoutMs: 200,
                  healthCacheTtlMs: 0,
                },
              ],
            },
          },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("memory manager reranker integration", () => {
  let workspaceDir: string;
  let indexPath: string;
  const managers: MemoryIndexManager[] = [];

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-rerank-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "a.md"), "alpha alpha keyword");
    await fs.writeFile(path.join(workspaceDir, "memory", "b.md"), "alpha keyword");
    await fs.writeFile(path.join(workspaceDir, "memory", "c.md"), "alpha keyword extra");
    embedBatch.mockClear();
    embedQuery.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const manager of managers.splice(0)) {
      await manager.close();
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  async function createManager(rerankEnabled: boolean): Promise<MemoryIndexManager> {
    const cfg = makeConfig(workspaceDir, indexPath, rerankEnabled);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const manager = result.manager as MemoryIndexManager;
    managers.push(manager);
    await manager.sync({ force: true });
    return manager;
  }

  it("reorders candidate paths using reranker ids", async () => {
    const baselineManager = await createManager(false);
    const baseline = await baselineManager.search("alpha keyword", { maxResults: 3, minScore: 0 });
    expect(baseline.length).toBeGreaterThan(1);

    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/v1/rerank")) {
        const bodyRaw = init?.body;
        const bodyText =
          typeof bodyRaw === "string"
            ? bodyRaw
            : bodyRaw instanceof Uint8Array
              ? new TextDecoder().decode(bodyRaw)
              : "{}";
        const body = JSON.parse(bodyText) as {
          documents?: Array<{ id: string }>;
        };
        const docs = body.documents ?? [];
        const reversed = [...docs].toReversed();
        return new Response(
          JSON.stringify({
            results: reversed.map((doc, idx) => ({
              id: doc.id,
              score: 1 - idx * 0.01,
              rank: idx + 1,
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const rerankManager = await createManager(true);
    const reranked = await rerankManager.search("alpha keyword", { maxResults: 3, minScore: 0 });
    expect(reranked.length).toBe(baseline.length);
    expect(reranked.map((entry) => entry.path)).toEqual(
      baseline.map((entry) => entry.path).toReversed(),
    );
  });

  it("fails open to baseline ordering on reranker 5xx", async () => {
    const baselineManager = await createManager(false);
    const baseline = await baselineManager.search("alpha keyword", { maxResults: 3, minScore: 0 });

    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/v1/rerank")) {
        return new Response(JSON.stringify({ reason: "timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const rerankManager = await createManager(true);
    const reranked = await rerankManager.search("alpha keyword", { maxResults: 3, minScore: 0 });
    expect(reranked.map((entry) => entry.path)).toEqual(baseline.map((entry) => entry.path));
  });

  it("appends missing ids in prior order when reranker returns partial output", async () => {
    const baselineManager = await createManager(false);
    const baseline = await baselineManager.search("alpha keyword", { maxResults: 3, minScore: 0 });

    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/v1/rerank")) {
        const bodyRaw = init?.body;
        const bodyText =
          typeof bodyRaw === "string"
            ? bodyRaw
            : bodyRaw instanceof Uint8Array
              ? new TextDecoder().decode(bodyRaw)
              : "{}";
        const body = JSON.parse(bodyText) as {
          documents?: Array<{ id: string }>;
        };
        const docs = body.documents ?? [];
        const picked = docs.at(-1);
        return new Response(
          JSON.stringify({
            results: picked ? [{ id: picked.id, score: 0.99, rank: 1 }] : [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const rerankManager = await createManager(true);
    const reranked = await rerankManager.search("alpha keyword", { maxResults: 3, minScore: 0 });

    expect(reranked.length).toBe(baseline.length);
    expect(reranked[0]?.path).toBe(baseline.at(-1)?.path);
    expect(reranked.slice(1).map((entry) => entry.path)).toEqual(
      baseline.slice(0, baseline.length - 1).map((entry) => entry.path),
    );
  });
});
