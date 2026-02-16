import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("injects project context files when session has active project", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, "projects", "alpha"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "projects", "alpha", "PROJECT.md"),
      "# Alpha\nProject context",
      "utf-8",
    );

    const storePath = path.join(workspaceDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const store = {
      [sessionKey]: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        projectId: "alpha",
        projectMemoryMode: "project+global",
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

    const cfg = {
      session: {
        store: storePath,
      },
    };

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      config: cfg as unknown as Parameters<typeof resolveBootstrapContextForRun>[0]["config"],
      sessionKey,
    });

    const projectFile = result.contextFiles.find(
      (file) => file.path === "projects/alpha/PROJECT.md",
    );

    expect(projectFile?.content).toContain("Project context");
  });
});
