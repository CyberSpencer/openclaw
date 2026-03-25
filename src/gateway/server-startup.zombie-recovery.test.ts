import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLockInspection } from "../agents/session-write-lock.js";
import type { SessionEntry } from "../config/sessions/types.js";

// Mock heavy transitive dependencies to avoid missing-package failures in tests.
vi.mock("@mariozechner/pi-ai", () => ({
  getOAuthProviders: vi.fn(() => []),
  getOAuthApiKey: vi.fn(async () => ({
    access: "test-token",
    expires: 0,
    provider: "",
  })),
}));
vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: vi.fn(() => []),
  getOAuthApiKey: vi.fn(async () => ({
    access: "test-token",
    expires: 0,
    provider: "",
  })),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

const { recoverZombieSessions } = await import("./server-startup-zombie-recovery.js");
const { loadSessionStore } = await import("../config/sessions/store.js");
const { peekSystemEvents, resetSystemEventsForTest } = await import("../infra/system-events.js");

function makeSessionEntry(sessionId: string, overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makeLockInspection(lockPath: string): SessionLockInspection {
  return {
    lockPath,
    pid: 12345,
    pidAlive: false,
    createdAt: new Date().toISOString(),
    ageMs: 120_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removed: true,
  };
}

describe("recoverZombieSessions", () => {
  let sessionsDir: string;
  let storePath: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "zombie-recovery-"));
    storePath = path.join(sessionsDir, "sessions.json");
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("skips when no locks were cleaned", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:chat:abc": makeSessionEntry("abc-123"),
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    await recoverZombieSessions({ sessionsDir, cleaned: [] });

    const result = loadSessionStore(storePath, { skipCache: true });
    expect(result["agent:main:chat:abc"].abortedLastRun).toBeUndefined();
  });

  it("marks zombie session as abortedLastRun and enqueues system event", async () => {
    const sessionId = "abc-123";
    const sessionKey = "agent:main:chat:abc";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: makeSessionEntry(sessionId),
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const lockPath = path.join(sessionsDir, `${sessionId}.jsonl.lock`);
    const cleaned = [makeLockInspection(lockPath)];

    await recoverZombieSessions({ sessionsDir, cleaned });

    const result = loadSessionStore(storePath, { skipCache: true });
    expect(result[sessionKey].abortedLastRun).toBe(true);
    expect(result[sessionKey].updatedAt).toBeGreaterThan(store[sessionKey].updatedAt);

    const events = peekSystemEvents(sessionKey);
    expect(events).toContain("[Agent interrupted — gateway restarted]");
  });

  it("does not mark sessions whose transcript was not locked", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:chat:abc": makeSessionEntry("abc-123"),
      "agent:main:chat:def": makeSessionEntry("def-456"),
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    // Only abc-123 had a stale lock
    const lockPath = path.join(sessionsDir, "abc-123.jsonl.lock");
    const cleaned = [makeLockInspection(lockPath)];

    await recoverZombieSessions({ sessionsDir, cleaned });

    const result = loadSessionStore(storePath, { skipCache: true });
    expect(result["agent:main:chat:abc"].abortedLastRun).toBe(true);
    expect(result["agent:main:chat:def"].abortedLastRun).toBeUndefined();
  });

  it("matches via sessionFile field when present", async () => {
    const sessionId = "abc-123";
    const sessionKey = "agent:main:chat:abc";
    const customFile = "20250101_abc-123.jsonl";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: makeSessionEntry(sessionId, { sessionFile: customFile }),
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    // Lock file matches the custom sessionFile, not the default <sessionId>.jsonl
    const lockPath = path.join(sessionsDir, `${customFile}.lock`);
    const cleaned = [makeLockInspection(lockPath)];

    await recoverZombieSessions({ sessionsDir, cleaned });

    const result = loadSessionStore(storePath, { skipCache: true });
    expect(result[sessionKey].abortedLastRun).toBe(true);
  });

  it("recovers multiple zombie sessions in one pass", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:chat:a": makeSessionEntry("sess-a"),
      "agent:main:chat:b": makeSessionEntry("sess-b"),
      "agent:main:chat:c": makeSessionEntry("sess-c"),
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const cleaned = [
      makeLockInspection(path.join(sessionsDir, "sess-a.jsonl.lock")),
      makeLockInspection(path.join(sessionsDir, "sess-c.jsonl.lock")),
    ];

    await recoverZombieSessions({ sessionsDir, cleaned });

    const result = loadSessionStore(storePath, { skipCache: true });
    expect(result["agent:main:chat:a"].abortedLastRun).toBe(true);
    expect(result["agent:main:chat:b"].abortedLastRun).toBeUndefined();
    expect(result["agent:main:chat:c"].abortedLastRun).toBe(true);

    expect(peekSystemEvents("agent:main:chat:a")).toHaveLength(1);
    expect(peekSystemEvents("agent:main:chat:b")).toHaveLength(0);
    expect(peekSystemEvents("agent:main:chat:c")).toHaveLength(1);
  });

  it("handles missing sessions.json gracefully", async () => {
    // No sessions.json exists - should not throw
    const lockPath = path.join(sessionsDir, "abc-123.jsonl.lock");
    const cleaned = [makeLockInspection(lockPath)];

    await expect(recoverZombieSessions({ sessionsDir, cleaned })).resolves.toBeUndefined();
  });
});
