import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

let SEARCH_RESULTS: Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}> = [];
const readFileMock = vi.fn(async () => ({ path: "", text: "ok" }));

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => {
      return {
        manager: {
          search: async () => SEARCH_RESULTS,
          readFile: readFileMock,
          status: () => ({
            backend: "builtin",
            provider: "openai",
            model: "text-embedding-3-small",
          }),
        },
      };
    },
  };
});

import type { OpenClawConfig } from "../../config/config.js";
import { createMemoryGetTool, createMemorySearchTool } from "./memory-tool.js";

async function writeSessionStore(params: {
  dir: string;
  sessionKey: string;
  projectId: string;
  mode: "project-only" | "project+global";
}) {
  const storePath = path.join(params.dir, "sessions.json");
  const store = {
    [params.sessionKey]: {
      sessionId: "s1",
      updatedAt: Date.now(),
      projectId: params.projectId,
      projectMemoryMode: params.mode,
    },
  };
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
  return storePath;
}

describe("memory tools project scope", () => {
  beforeEach(() => {
    SEARCH_RESULTS = [];
    readFileMock.mockClear();
  });

  it("filters memory_search results for project-only scope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-scope-"));
    const sessionKey = "agent:main:main";
    const storePath = await writeSessionStore({
      dir,
      sessionKey,
      projectId: "alpha",
      mode: "project-only",
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };

    SEARCH_RESULTS = [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "global",
      },
      {
        path: "projects/alpha/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.8,
        snippet: "alpha",
      },
      {
        path: "projects/beta/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.7,
        snippet: "beta",
      },
    ];

    const tool = createMemorySearchTool({
      config: cfg as unknown as OpenClawConfig,
      agentSessionKey: sessionKey,
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    const raw = result.details;
    if (!raw || typeof raw !== "object") {
      throw new Error("missing tool details");
    }
    const results = (raw as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new Error("missing results");
    }
    const paths = results
      .map((entry) =>
        entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined,
      )
      .filter((value): value is string => typeof value === "string");
    expect(paths).toEqual(["projects/alpha/MEMORY.md"]);
  });

  it("includes global memory when mode=project+global", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-scope-"));
    const sessionKey = "agent:main:main";
    const storePath = await writeSessionStore({
      dir,
      sessionKey,
      projectId: "alpha",
      mode: "project+global",
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };

    SEARCH_RESULTS = [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "global",
      },
      {
        path: "projects/alpha/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.8,
        snippet: "alpha",
      },
      {
        path: "projects/beta/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.7,
        snippet: "beta",
      },
    ];

    const tool = createMemorySearchTool({
      config: cfg as unknown as OpenClawConfig,
      agentSessionKey: sessionKey,
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    const raw = result.details;
    if (!raw || typeof raw !== "object") {
      throw new Error("missing tool details");
    }
    const results = (raw as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new Error("missing results");
    }
    const paths = results
      .map((entry) =>
        entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined,
      )
      .filter((value): value is string => typeof value === "string");
    expect(paths).toEqual(["MEMORY.md", "projects/alpha/MEMORY.md"]);
  });

  it("blocks memory_get for paths outside project scope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-scope-"));
    const sessionKey = "agent:main:main";
    const storePath = await writeSessionStore({
      dir,
      sessionKey,
      projectId: "alpha",
      mode: "project-only",
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };

    const tool = createMemoryGetTool({
      config: cfg as unknown as OpenClawConfig,
      agentSessionKey: sessionKey,
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_2", { path: "projects/beta/MEMORY.md" });
    const raw = result.details;
    if (!raw || typeof raw !== "object") {
      throw new Error("missing tool details");
    }
    const disabled = (raw as { disabled?: unknown }).disabled;
    const error = (raw as { error?: unknown }).error;
    expect(disabled).toBe(true);
    expect(error).toContain("Path not allowed");
    expect(readFileMock).not.toHaveBeenCalled();
  });
});
