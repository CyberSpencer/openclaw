import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveThemesStorePath } from "../config/themes.js";
import { handleGatewayRequest } from "./server-methods.js";
import { installGatewayTestHooks, testState } from "./test-helpers.js";

installGatewayTestHooks();

async function createStorePaths() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-themes-test-"));
  const sessionStorePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = sessionStorePath;
  return {
    dir,
    sessionStorePath,
    themeStorePath: resolveThemesStorePath(sessionStorePath, { agentId: "main" }),
  };
}

async function writeThemeStore(
  pathname: string,
  store: Record<string, Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function gatewayRequest(params: {
  method: string;
  payload: Record<string, unknown>;
  scopes: string[];
}) {
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      }
    | undefined;

  await handleGatewayRequest({
    req: {
      type: "req",
      id: "1",
      method: params.method,
      params: params.payload,
    },
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    client: {
      connect: { role: "operator", scopes: params.scopes },
    } as never,
    isWebchatConnect: () => false,
    context: {} as never,
  });

  if (!response) {
    throw new Error(`no response for ${params.method}`);
  }
  return response;
}

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("gateway theme methods", () => {
  it("creates, lists, patches, resolves, and archives theme lanes", async () => {
    const paths = await createStorePaths();
    tempDirs.push(paths.dir);

    const created = await gatewayRequest({
      method: "themes.create",
      payload: {
        agentId: "main",
        label: "repo/workstream",
        brief: "Keep implementation work for the active repo together.",
      },
      scopes: ["operator.admin"],
    });
    expect(created.ok).toBe(true);
    const createdTheme = (created.payload as { theme: { id: string; label: string } }).theme;
    expect(createdTheme.label).toBe("repo/workstream");

    const listed = await gatewayRequest({
      method: "themes.list",
      payload: { agentId: "main" },
      scopes: ["operator.read"],
    });
    expect(listed.ok).toBe(true);
    expect((listed.payload as { themes: Array<{ label: string }> }).themes).toEqual([
      expect.objectContaining({ label: "repo/workstream" }),
    ]);

    const patched = await gatewayRequest({
      method: "themes.patch",
      payload: {
        agentId: "main",
        id: createdTheme.id,
        label: "repo lane",
        brief: "Keep implementation, review, and repo-specific work together.",
      },
      scopes: ["operator.admin"],
    });
    expect(patched.ok).toBe(true);
    expect((patched.payload as { theme: { label: string; brief?: string } }).theme).toEqual(
      expect.objectContaining({
        label: "repo lane",
        brief: "Keep implementation, review, and repo-specific work together.",
      }),
    );

    const resolved = await gatewayRequest({
      method: "themes.resolve",
      payload: { agentId: "main", id: createdTheme.id },
      scopes: ["operator.read"],
    });
    expect(resolved.ok).toBe(true);
    expect((resolved.payload as { theme: { id: string; label: string } }).theme).toEqual(
      expect.objectContaining({
        id: createdTheme.id,
        label: "repo lane",
      }),
    );

    const archived = await gatewayRequest({
      method: "themes.archive",
      payload: { agentId: "main", id: createdTheme.id },
      scopes: ["operator.admin"],
    });
    expect(archived.ok).toBe(true);
    expect((archived.payload as { theme: { status: string } }).theme.status).toBe("archived");
  });

  it("suggests creating a new lane for a long off-theme message", async () => {
    const paths = await createStorePaths();
    tempDirs.push(paths.dir);

    await writeThemeStore(paths.themeStorePath, {
      "theme-messaging": {
        label: "messaging/comms",
        brief: "draft outbound customer reply update pricing",
        status: "active",
        canonicalSessionKey: "agent:main:lane:theme-messaging",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      },
      "theme-ops": {
        label: "ops/admin",
        brief: "infra maintenance tokens alerts incidents",
        status: "active",
        canonicalSessionKey: "agent:main:lane:theme-ops",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      },
    });

    const suggested = await gatewayRequest({
      method: "themes.suggest",
      payload: {
        agentId: "main",
        sessionKey: "agent:main:main",
        message: "plan vendor onboarding packet budget staffing timeline approvals rollout",
      },
      scopes: ["operator.write"],
    });

    expect(suggested.ok).toBe(true);
    expect(suggested.payload).toEqual(
      expect.objectContaining({
        action: "create_new_lane",
        suggestedLabel: expect.any(String),
      }),
    );
  });
});
