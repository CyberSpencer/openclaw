import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeProjectId, resolveProjectDir } from "./projects.js";

export type InitProjectResult = {
  projectId: string;
  projectDir: string;
  created: string[];
  skipped: string[];
};

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

async function writeFileIfMissing(absPath: string, content: string): Promise<boolean> {
  if (await fileExists(absPath)) {
    return false;
  }

  const parent = path.dirname(absPath);
  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      throw new Error(`Cannot create ${absPath}: ${parent} exists and is not a directory`);
    }
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      await fs.mkdir(parent, { recursive: true });
    } else if (err instanceof Error) {
      throw err;
    } else {
      throw new Error(String(err), { cause: err });
    }
  }

  await fs.writeFile(absPath, content, "utf-8");
  return true;
}

export async function initProject(params: {
  workspaceDir: string;
  projectId: string;
}): Promise<InitProjectResult> {
  const projectId = sanitizeProjectId(params.projectId);
  if (!projectId) {
    throw new Error("Invalid project id");
  }

  const projectDir = resolveProjectDir(params.workspaceDir, projectId);
  await fs.mkdir(projectDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  const files: Array<{ rel: string; content: string }> = [
    {
      rel: "PROJECT.md",
      content: `# ${projectId}\n\nDescribe what this project is and what success looks like.\n`,
    },
    {
      rel: "CONTEXT.md",
      content: "# Context\n\nKey links, constraints, and background for this project.\n",
    },
    {
      rel: "instructions/README.md",
      content:
        "# Instructions\n\nAdd any recurring instructions for this project here (or as separate .md files in this folder).\n",
    },
    {
      rel: "MEMORY.md",
      content: "# Project Memory\n\n(Notes specific to this project.)\n",
    },
    {
      rel: "variables.env",
      content: "# Non-secret project env vars\n# EXAMPLE_VAR=value\n",
    },
    {
      rel: "secrets.env",
      content: "# Secret project env vars (DO NOT COMMIT)\n# GITHUB_TOKEN=...\n# GH_TOKEN=...\n",
    },
    {
      rel: ".gitignore",
      content: "secrets.env\n.env\n",
    },
  ];

  for (const file of files) {
    const abs = path.join(projectDir, file.rel);
    const didCreate = await writeFileIfMissing(abs, file.content);
    const relPath = path.relative(params.workspaceDir, abs).replace(/\\/g, "/");
    if (didCreate) {
      created.push(relPath);
    } else {
      skipped.push(relPath);
    }
  }

  return { projectId, projectDir, created, skipped };
}
