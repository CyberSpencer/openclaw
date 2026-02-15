import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject } from "./init.js";

describe("projects/init", () => {
  it("creates a project skeleton and is idempotent", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-init-"));

    const first = await initProject({ workspaceDir: ws, projectId: "Alpha Project" });
    expect(first.projectId).toBe("alpha-project");
    expect(first.created.length).toBeGreaterThan(0);

    const second = await initProject({ workspaceDir: ws, projectId: "alpha-project" });
    expect(second.projectId).toBe("alpha-project");
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});
