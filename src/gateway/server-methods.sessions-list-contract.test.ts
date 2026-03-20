import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let sharedSessionStoreDir: string;
let sessionStoreCaseSeq = 0;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
  sharedSessionStoreDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-sessions-list-contract-"),
  );
});

afterAll(async () => {
  await harness.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

async function createSessionStoreDir() {
  const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { dir, storePath };
}

async function openClient() {
  return await harness.openClient();
}

describe("gateway sessions.list contract", () => {
  it("returns pagination metadata for filtered direct sessions", async () => {
    const { storePath } = await createSessionStoreDir();
    const now = Date.now();
    await writeSessionStore({
      entries: {
        global: { sessionId: "sess-global", updatedAt: now },
        "discord:group:dev": { sessionId: "sess-group", updatedAt: now - 1_000 },
        "subagent:one": { sessionId: "sess-subagent", updatedAt: now - 2_000 },
        main: { sessionId: "sess-main", updatedAt: now - 3_000 },
      },
    });

    const { ws } = await openClient();
    try {
      const directOnly = await rpcReq<{
        path: string;
        count: number;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        nextOffset: number | null;
        sessions: Array<{ key: string }>;
      }>(ws, "sessions.list", {
        includeGlobal: true,
        includeUnknown: false,
        kind: "direct",
        includeSubagents: false,
        limit: 1,
        offset: 1,
      });

      expect(directOnly.ok).toBe(true);
      expect(directOnly.payload?.path).toBe(storePath);
      expect(directOnly.payload?.count).toBe(0);
      expect(directOnly.payload?.total).toBe(1);
      expect(directOnly.payload?.limit).toBe(1);
      expect(directOnly.payload?.offset).toBe(1);
      expect(directOnly.payload?.hasMore).toBe(false);
      expect(directOnly.payload?.nextOffset).toBeNull();
      expect(directOnly.payload?.sessions).toEqual([]);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  });

  it("includes subagents in direct pagination only when requested", async () => {
    await createSessionStoreDir();
    const now = Date.now();
    await writeSessionStore({
      entries: {
        "subagent:one": { sessionId: "sess-subagent", updatedAt: now },
        main: { sessionId: "sess-main", updatedAt: now - 1_000 },
      },
    });

    const { ws } = await openClient();
    try {
      const directWithSubagents = await rpcReq<{
        count: number;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        nextOffset: number | null;
        sessions: Array<{ key: string }>;
      }>(ws, "sessions.list", {
        includeGlobal: false,
        includeUnknown: false,
        kind: "direct",
        includeSubagents: true,
        limit: 1,
        offset: 1,
      });

      expect(directWithSubagents.ok).toBe(true);
      expect(directWithSubagents.payload?.count).toBe(1);
      expect(directWithSubagents.payload?.total).toBe(2);
      expect(directWithSubagents.payload?.limit).toBe(1);
      expect(directWithSubagents.payload?.offset).toBe(1);
      expect(directWithSubagents.payload?.hasMore).toBe(false);
      expect(directWithSubagents.payload?.nextOffset).toBeNull();
      expect(directWithSubagents.payload?.sessions.map((session) => session.key)).toEqual([
        "agent:main:main",
      ]);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    }
  });
});
