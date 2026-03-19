import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemorySearchManager } from "./index.js";

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getOAuthApiKey: () => undefined,
  getOAuthProviders: () => [],
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

describe("memory watcher runtime", () => {
  let manager: MemorySearchManager | null = null;
  let workspaceDir = "";

  afterEach(async () => {
    if (manager?.close) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("indexes new markdown files via real chokidar directory watches", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-runtime-"));
    const memoryDir = path.join(workspaceDir, "memory");
    const extraDir = path.join(workspaceDir, "extra");
    const pendingDir = path.join(workspaceDir, "pending");
    const pendingFile = path.join(pendingDir, "later.md");
    const missingDottedDir = path.join(workspaceDir, "docs.v2");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "initial.md"), "# initial\n");

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            extraPaths: [extraDir, pendingFile, missingDottedDir],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    await manager.sync?.({ force: true });
    expect(manager.status().files).toBe(1);

    await fs.mkdir(path.join(memoryDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "nested", "new.md"), "# nested\n");
    await waitFor(async () => manager?.status().files === 2);

    await fs.writeFile(path.join(extraDir, "extra.md"), "# extra\n");
    await waitFor(async () => manager?.status().files === 3);

    await fs.writeFile(pendingFile, "# pending\n");
    await waitFor(async () => manager?.status().files === 4);

    await fs.mkdir(missingDottedDir, { recursive: true });
    await fs.writeFile(path.join(missingDottedDir, "late.md"), "# dotted\n");
    await waitFor(async () => manager?.status().files === 5);

    await fs.mkdir(path.join(memoryDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "node_modules", "pkg", "ignored.md"), "# ignore\n");
    await sleep(400);
    expect(manager.status().files).toBe(5);
  });
});

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
