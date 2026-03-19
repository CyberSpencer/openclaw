import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

const hoisted = vi.hoisted(() => ({
  providerCreateCalls: 0,
  providerDelayMs: 0,
  providerFailuresRemaining: 0,
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => {
    hoisted.providerCreateCalls += 1;
    if (hoisted.providerDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, hoisted.providerDelayMs));
    }
    if (hoisted.providerFailuresRemaining > 0) {
      hoisted.providerFailuresRemaining -= 1;
      throw new Error("provider bootstrap failed");
    }
    return {
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        maxInputTokens: 8192,
        embedQuery: async () => [0, 1, 0],
        embedBatch: async (texts: string[]) => texts.map(() => [0, 1, 0]),
      },
    };
  },
}));

describe("memory manager cache hydration", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-concurrent-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
    hoisted.providerCreateCalls = 0;
    hoisted.providerDelayMs = 50;
    hoisted.providerFailuresRemaining = 0;
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("deduplicates concurrent manager creation for the same cache key", async () => {
    const indexPath = path.join(workspaceDir, "index.sqlite");
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () => await getMemorySearchManager({ cfg, agentId: "main" }),
      ),
    );
    const managers = results
      .map((result) => result.manager)
      .filter((manager): manager is MemoryIndexManager => Boolean(manager));

    expect(managers).toHaveLength(12);
    expect(new Set(managers).size).toBe(1);
    expect(hoisted.providerCreateCalls).toBe(1);

    await managers[0].close();
  });

  it("clears the pending hydration slot after a failed concurrent bootstrap", async () => {
    const indexPath = path.join(workspaceDir, "index.sqlite");
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    hoisted.providerFailuresRemaining = 1;

    const failed = await Promise.all([
      getMemorySearchManager({ cfg, agentId: "main" }),
      getMemorySearchManager({ cfg, agentId: "main" }),
    ]);
    expect(failed).toEqual([
      { manager: null, error: "provider bootstrap failed" },
      { manager: null, error: "provider bootstrap failed" },
    ]);
    expect(hoisted.providerCreateCalls).toBe(1);

    const retried = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(retried.manager).not.toBeNull();
    expect(hoisted.providerCreateCalls).toBe(2);

    await retried.manager?.close?.();
  });
});
