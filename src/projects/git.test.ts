import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../process/exec.js", () => {
  return {
    runCommandWithTimeout: vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    })),
  };
});

import { runCommandWithTimeout } from "../process/exec.js";
import { cloneProjectRepo } from "./git.js";

describe("projects/git", () => {
  it("clones into projects/<id>/repo and uses token header when present (github)", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-git-"));
    const projectId = "alpha";
    const projectDir = path.join(ws, "projects", projectId);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "secrets.env"),
      "GITHUB_TOKEN=ghp_abcdef1234567890ghij\n",
    );

    const url = "https://github.com/example/repo.git";

    const res = await cloneProjectRepo({
      workspaceDir: ws,
      projectId,
      url,
    });

    expect(res.destDir.endsWith("projects/alpha/repo")).toBe(true);
    expect(res.usedToken).toBe(true);

    expect(runCommandWithTimeout).toHaveBeenCalled();
    const call = (runCommandWithTimeout as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    const argv = call?.[0] as string[];

    // Should include git and clone
    expect(argv[0]).toBe("git");
    expect(argv.join(" ")).toContain("clone");
    // Should include http.extraHeader configuration.
    expect(argv.join(" ")).toContain("http.extraHeader=Authorization:");
  });

  it("rejects destSubdir traversal", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-git-"));
    const projectId = "alpha";
    const projectDir = path.join(ws, "projects", projectId);
    await fs.mkdir(projectDir, { recursive: true });

    await expect(
      cloneProjectRepo({
        workspaceDir: ws,
        projectId,
        url: "https://github.com/example/repo.git",
        destSubdir: "../../tmp/evil",
      }),
    ).rejects.toThrow(/destSubdir must stay within the project directory/i);
  });
});
