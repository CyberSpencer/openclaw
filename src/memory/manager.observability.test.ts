import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";

vi.mock(
  "@mariozechner/pi-ai/oauth",
  () => ({
    getOAuthApiKey: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
  }),
  { virtual: true },
);

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "mock-embed",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://dgx.example/v1",
      headers: { "Content-Type": "application/json" },
      model: "mock-embed",
    },
  }),
}));

import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

function makeConfig(workspaceDir: string, indexPath: string) {
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
          query: { minScore: 0, maxResults: 5 },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

function tempLogPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
  );
}

async function readLogRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      const parts = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "0" in parsed
          ? [
              (parsed as Record<string, unknown>)["0"],
              (parsed as Record<string, unknown>)["1"],
              (parsed as Record<string, unknown>)["2"],
            ]
          : null;
      if (!parts) {
        return parsed as Record<string, unknown>;
      }
      const bindings =
        typeof parts[0] === "string"
          ? ((JSON.parse(parts[0]) as Record<string, unknown>) ?? {})
          : {};
      const meta =
        parts[1] && typeof parts[1] === "object" ? (parts[1] as Record<string, unknown>) : {};
      const message = typeof parts[2] === "string" ? parts[2] : undefined;
      return {
        ...bindings,
        ...meta,
        ...(message ? { message } : {}),
      };
    });
}

describe("memory manager observability", () => {
  let workspaceDir: string;
  let indexPath: string;
  let logPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-observability-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    logPath = tempLogPath("memory-observability");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-03-24.md"), "hello memory\n");
    embedBatch.mockClear();
    embedQuery.mockClear();
    resetLogger();
    setLoggerOverride({
      level: "debug",
      consoleLevel: "silent",
      file: logPath,
    });
  });

  afterEach(async () => {
    resetLogger();
    setLoggerOverride(null);
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("emits structured sync, write, embedding, and search logs", async () => {
    const cfg = makeConfig(workspaceDir, indexPath);
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;

    await manager.sync({ reason: "test", force: true });
    await manager.search("hello", { maxResults: 1, minScore: 0 });
    const records = await readLogRecords(logPath);

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.embeddings.provider",
          phase: "resolved",
          provider: "openai",
          remoteEndpoint: "https://dgx.example/v1",
        }),
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.sync",
          phase: "start",
          syncReason: "test",
          force: true,
        }),
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.index.write",
          phase: "complete",
          source: "memory",
          path: "memory/2026-03-24.md",
        }),
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.index.flush",
          phase: "complete",
          syncReason: "test",
        }),
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.embeddings.query",
          phase: "complete",
          provider: "openai",
          remoteEndpoint: "https://dgx.example/v1",
        }),
        expect.objectContaining({
          subsystem: "memory",
          event: "memory.search",
          phase: "complete",
          provider: "openai",
          remoteEndpoint: "https://dgx.example/v1",
        }),
      ]),
    );
  });
});
