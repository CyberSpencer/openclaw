import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
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

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";
  let extraFile = "";
  let pendingDir = "";
  let pendingFile = "";

  afterEach(async () => {
    watchMock.mockClear();
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
      extraFile = "";
      pendingDir = "";
      pendingFile = "";
    }
  });

  it("watches markdown directories and files without chokidar globs", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    extraFile = path.join(workspaceDir, "standalone.md");
    pendingDir = path.join(workspaceDir, "pending");
    pendingFile = path.join(pendingDir, "later.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.md"), "hello");
    await fs.writeFile(extraFile, "standalone");

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
            extraPaths: [extraDir, extraFile, pendingFile],
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
    manager = result.manager as unknown as MemoryIndexManager;

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "memory.md"),
        path.join(workspaceDir, "memory"),
        extraDir,
        extraFile,
        pendingDir,
      ]),
    );
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 });

    const ignored = options.ignored as ((watchPath: string) => boolean) | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.txt"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
  });
});
