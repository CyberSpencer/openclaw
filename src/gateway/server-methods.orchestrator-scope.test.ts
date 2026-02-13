import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";

type OrchestratorState = {
  version: 1;
  selectedBoardId: string;
  boards: Array<{
    id: string;
    title: string;
    lanes: Array<{ id: string; title: string }>;
    cards: Array<{
      id: string;
      laneId: string;
      title: string;
      task: string;
      agentId: string;
      createdAt: number;
      updatedAt: number;
    }>;
    createdAt: number;
    updatedAt: number;
  }>;
};

function buildState(cardId: string): OrchestratorState {
  const now = Date.now();
  return {
    version: 1,
    selectedBoardId: "main",
    boards: [
      {
        id: "main",
        title: "Mission Control",
        lanes: [
          { id: "backlog", title: "Backlog" },
          { id: "running", title: "Running" },
        ],
        cards: [
          {
            id: cardId,
            laneId: "backlog",
            title: `Card ${cardId}`,
            task: `Task ${cardId}`,
            agentId: "main",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

async function invoke(params: {
  method: "orchestrator.get" | "orchestrator.set" | "orchestrator.reset";
  args?: Record<string, unknown>;
}) {
  const respond = vi.fn();
  const broadcasts: Array<{ event: string; payload: unknown }> = [];

  await handleGatewayRequest({
    req: {
      type: "req",
      id: "1",
      method: params.method,
      params: params.args ?? {},
    },
    respond,
    client: {
      connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    } as never,
    isWebchatConnect: false,
    context: {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    } as never,
  });

  const [ok, payload, err] = respond.mock.calls[0] ?? [];
  return { ok, payload, err, broadcasts };
}

describe("gateway orchestrator board scoping", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalHome = process.env.OPENCLAW_HOME;
  let tempStateDir = "";

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-scope-"));
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
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy main board data without loss", async () => {
    const legacyPath = path.join(tempStateDir, "control-ui", "orchestrator.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify(buildState("legacy-card"), null, 2)}\n`,
      "utf8",
    );

    const getBefore = await invoke({ method: "orchestrator.get" });
    expect(getBefore.ok).toBe(true);
    expect(getBefore.payload).toMatchObject({
      exists: true,
      scopeKey: "main",
      state: {
        boards: [
          expect.objectContaining({ cards: [expect.objectContaining({ id: "legacy-card" })] }),
        ],
      },
    });

    const setRes = await invoke({
      method: "orchestrator.set",
      args: { state: buildState("legacy-card") },
    });
    expect(setRes.ok).toBe(true);

    const scopedMainPath = path.join(tempStateDir, "control-ui", "orchestrator", "main.json");
    await expect(fs.access(scopedMainPath)).resolves.toBeUndefined();
  });

  it("isolates boards by rootConversationId scope", async () => {
    const setA = await invoke({
      method: "orchestrator.set",
      args: {
        rootConversationId: "conv-a",
        state: buildState("card-a"),
      },
    });
    const setB = await invoke({
      method: "orchestrator.set",
      args: {
        rootConversationId: "conv-b",
        state: buildState("card-b"),
      },
    });

    expect(setA.ok).toBe(true);
    expect(setB.ok).toBe(true);
    expect(setA.payload.scopeKey).not.toBe(setB.payload.scopeKey);

    const getA = await invoke({
      method: "orchestrator.get",
      args: { rootConversationId: "conv-a" },
    });
    const getB = await invoke({
      method: "orchestrator.get",
      args: { rootConversationId: "conv-b" },
    });

    expect(getA.ok).toBe(true);
    expect(getB.ok).toBe(true);
    expect(getA.payload).toMatchObject({
      state: {
        boards: [expect.objectContaining({ cards: [expect.objectContaining({ id: "card-a" })] })],
      },
    });
    expect(getB.payload).toMatchObject({
      state: {
        boards: [expect.objectContaining({ cards: [expect.objectContaining({ id: "card-b" })] })],
      },
    });
  });
});
