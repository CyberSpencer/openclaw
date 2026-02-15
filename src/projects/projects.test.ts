import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listProjectContextFiles, listProjectMemoryRoots, sanitizeProjectId } from "./projects.js";

async function makeTmpWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projects-"));
  await fs.mkdir(path.join(dir, "projects"), { recursive: true });
  return dir;
}

describe("projects", () => {
  it("sanitizes project ids", () => {
    expect(sanitizeProjectId("  My Project ")).toBe("my-project");
    // Path traversal should be neutralized.
    expect(sanitizeProjectId("../evil")).toBe("evil");
    expect(sanitizeProjectId("a/b/c")).toBe("a-b-c");
  });

  it("lists project context files in priority order with caps", async () => {
    const ws = await makeTmpWorkspace();
    const projectDir = path.join(ws, "projects", "alpha");
    await fs.mkdir(path.join(projectDir, "instructions"), { recursive: true });

    await fs.writeFile(path.join(projectDir, "PROJECT.md"), "# Alpha\nProject", "utf-8");
    await fs.writeFile(path.join(projectDir, "CONTEXT.md"), "Context here", "utf-8");
    await fs.writeFile(path.join(projectDir, "instructions", "01.md"), "I1", "utf-8");

    const files = await listProjectContextFiles(ws, "alpha", {
      maxFiles: 2,
      maxCharsPerFile: 50,
      maxTotalChars: 200,
    });

    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe("projects/alpha/PROJECT.md");
    expect(files[1]?.path).toBe("projects/alpha/CONTEXT.md");
  });

  it("returns memory roots", () => {
    const roots = listProjectMemoryRoots("/tmp/ws", "alpha");
    expect(roots.some((p) => p.endsWith("/projects/alpha/MEMORY.md"))).toBe(true);
    expect(roots.some((p) => p.endsWith("/projects/alpha/memory"))).toBe(true);
  });
});
