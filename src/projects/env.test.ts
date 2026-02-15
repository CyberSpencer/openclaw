import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEnvOverrides,
  applyProjectEnvOverrides,
  parseEnvFile,
  resolveProjectDir,
} from "./env.js";

describe("projects/env", () => {
  it("parses env files with comments and quotes", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "API_BASE_URL=https://example.com # inline",
        "TOKEN='abc123'",
        'PASSWORD="p@ss word"',
        "",
      ].join("\n"),
    );
    expect(parsed.API_BASE_URL).toBe("https://example.com");
    expect(parsed.TOKEN).toBe("abc123");
    expect(parsed.PASSWORD).toBe("p@ss word");
  });

  it("applies and restores overrides", () => {
    const env: NodeJS.ProcessEnv = { FOO: "old" };
    const restore = applyEnvOverrides({ env, overrides: { FOO: "new", BAR: "x" } });
    expect(env.FOO).toBe("new");
    expect(env.BAR).toBe("x");
    restore();
    expect(env.FOO).toBe("old");
    expect(env.BAR).toBeUndefined();
  });

  it("loads project variables + secrets and merges", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-env-"));
    const projectId = "alpha";
    const projectDir = resolveProjectDir(ws, projectId);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "variables.env"), "FOO=1\n", "utf-8");
    await fs.writeFile(path.join(projectDir, "secrets.env"), "TOKEN=abc\n", "utf-8");

    const env: NodeJS.ProcessEnv = {};
    const { restore } = await applyProjectEnvOverrides({
      workspaceDir: ws,
      projectId,
      env,
    });

    expect(env.FOO).toBe("1");
    expect(env.TOKEN).toBe("abc");

    restore();
    expect(env.FOO).toBeUndefined();
    expect(env.TOKEN).toBeUndefined();
  });
});
