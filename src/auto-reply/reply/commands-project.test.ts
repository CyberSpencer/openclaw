import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import { handleProjectCommand } from "./commands-project.js";
import { buildCommandContext } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-cmd-"));
  await fs.mkdir(path.join(testWorkspaceDir, "projects", "acme"), { recursive: true });
  await fs.mkdir(path.join(testWorkspaceDir, "projects", "beta"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, { recursive: true, force: true });
});

function buildParams(commandBody: string) {
  const cfg = {
    commands: { text: true },
    whatsapp: { allowFrom: ["*"] },
  } as OpenClawConfig;

  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  const sessionKey = "agent:main:main";
  const sessionEntry: SessionEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionEntry,
    previousSessionEntry: undefined,
    sessionStore,
    sessionKey,
    storePath: undefined,
    workspaceDir: testWorkspaceDir,
    defaultGroupActivation: () => "mention" as const,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
    agentId: "main",
  };
}

describe("/project command", () => {
  it("sets project id (sanitized) and defaults memory mode", async () => {
    const params = buildParams("/project set Acme Widgets");
    const result = await handleProjectCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(params.sessionEntry.projectId).toBe("acme-widgets");
    expect(params.sessionEntry.projectMemoryMode).toBe("project+global");
    expect(result?.reply?.text).toContain("Project set to acme-widgets");
  });

  it("shows current project", async () => {
    const params = buildParams("/project show");
    params.sessionEntry.projectId = "acme";
    params.sessionEntry.projectMemoryMode = "project-only";
    const result = await handleProjectCommand(params, true);
    expect(result?.reply?.text).toContain("Project: acme");
    expect(result?.reply?.text).toContain("project-only");
  });

  it("lists projects from workspace", async () => {
    const params = buildParams("/project list");
    const result = await handleProjectCommand(params, true);
    expect(result?.reply?.text).toContain("Projects");
    expect(result?.reply?.text).toContain("- acme");
    expect(result?.reply?.text).toContain("- beta");
  });

  it("sets memory mode", async () => {
    const params = buildParams("/project mode project-only");
    params.sessionEntry.projectId = "acme";
    const result = await handleProjectCommand(params, true);
    expect(params.sessionEntry.projectMemoryMode).toBe("project-only");
    expect(result?.reply?.text).toContain("project-only");
  });

  it("clears project", async () => {
    const params = buildParams("/project clear");
    params.sessionEntry.projectId = "acme";
    params.sessionEntry.projectMemoryMode = "project-only";
    const result = await handleProjectCommand(params, true);
    expect(params.sessionEntry.projectId).toBeUndefined();
    expect(params.sessionEntry.projectMemoryMode).toBeUndefined();
    expect(result?.reply?.text).toContain("Cleared");
  });
});
