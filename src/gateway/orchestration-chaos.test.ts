import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import { handleGatewayRequest } from "./server-methods.js";

async function invoke(params: {
  method: string;
  args?: Record<string, unknown>;
  scopes?: string[];
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "1",
      method: params.method,
      params: params.args ?? {},
    },
    respond,
    client: {
      connect: { role: "operator", scopes: params.scopes ?? ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: false,
    context: {
      broadcast: vi.fn(),
      logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as never,
  });
  return respond.mock.calls[0] as [boolean, unknown, unknown?];
}

describe("orchestration chaos matrix", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalHome = process.env.OPENCLAW_HOME;
  let tempStateDir = "";

  beforeEach(async () => {
    resetSubagentRegistryForTests();
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-chaos-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_HOME = tempStateDir;
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("isolates multi-root fanout results with sessions.subagents filters", async () => {
    addSubagentRunForTests({
      runId: "r-a1",
      childSessionKey: "agent:main:subagent:a1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "a1",
      cleanup: "keep",
      rootConversationId: "conv-a",
      threadId: "thread-1",
      createdAt: 1,
      startedAt: 2,
    });
    addSubagentRunForTests({
      runId: "r-a2",
      childSessionKey: "agent:main:subagent:a2",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "a2",
      cleanup: "keep",
      rootConversationId: "conv-a",
      threadId: "thread-2",
      createdAt: 3,
      startedAt: 4,
    });
    addSubagentRunForTests({
      runId: "r-b1",
      childSessionKey: "agent:main:subagent:b1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "b1",
      cleanup: "keep",
      rootConversationId: "conv-b",
      threadId: "thread-1",
      createdAt: 5,
      startedAt: 6,
    });
    addSubagentRunForTests({
      runId: "r-other-agent",
      childSessionKey: "agent:ops:subagent:o1",
      requesterSessionKey: "agent:ops:main",
      requesterDisplayKey: "main",
      task: "o1",
      cleanup: "keep",
      rootConversationId: "conv-a",
      threadId: "thread-1",
      createdAt: 7,
      startedAt: 8,
    });

    const [ok, payload] = await invoke({
      method: "sessions.subagents",
      args: {
        requesterSessionKey: "agent:main:main",
        rootConversationId: "conv-a",
      },
    });

    expect(ok).toBe(true);
    const typed = payload as { count?: number; tasks?: Array<{ runId?: string }> };
    const runIds = (typed.tasks ?? []).map((task) => task.runId);
    expect(runIds).toEqual(expect.arrayContaining(["r-a1", "r-a2"]));
    expect(runIds).not.toContain("r-b1");
    expect(runIds).not.toContain("r-other-agent");
  });

  it("rejects stale-baseHash orchestrator writes under concurrent updates", async () => {
    const initialState = {
      version: 1,
      selectedBoardId: "main",
      boards: [],
    };

    const [okSet1, set1Payload] = await invoke({
      method: "orchestrator.set",
      args: { state: initialState },
      scopes: ["operator.admin"],
    });
    expect(okSet1).toBe(true);
    const firstHash = (set1Payload as { hash?: string })?.hash ?? "";
    expect(firstHash).not.toBe("");

    const [okSet2, set2Payload] = await invoke({
      method: "orchestrator.set",
      args: {
        state: {
          ...initialState,
          boards: [{ id: "main", title: "A", lanes: [], cards: [], createdAt: 1, updatedAt: 1 }],
        },
        baseHash: firstHash,
      },
      scopes: ["operator.admin"],
    });
    expect(okSet2).toBe(true);
    expect((set2Payload as { hash?: string })?.hash).not.toBe(firstHash);

    const [okSetStale, _payload, staleErr] = await invoke({
      method: "orchestrator.set",
      args: {
        state: {
          ...initialState,
          boards: [{ id: "main", title: "B", lanes: [], cards: [], createdAt: 2, updatedAt: 2 }],
        },
        baseHash: firstHash,
      },
      scopes: ["operator.admin"],
    });

    expect(okSetStale).toBe(false);
    expect(staleErr).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("baseHash mismatch"),
    });
  });
});
