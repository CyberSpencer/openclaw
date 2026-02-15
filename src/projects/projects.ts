import fs from "node:fs/promises";
import path from "node:path";

export type ProjectMemoryMode = "project-only" | "project+global";

export type ProjectContextFile = {
  /** Workspace-relative path (for display in prompt). */
  path: string;
  content: string;
};

export type ListProjectContextFilesOptions = {
  /** Max number of files to include. Default: 8. */
  maxFiles?: number;
  /** Max characters per file. Default: 12_000. */
  maxCharsPerFile?: number;
  /** Max total characters across all files. Default: 24_000. */
  maxTotalChars?: number;
};

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_CHARS_PER_FILE = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 24_000;

export function sanitizeProjectId(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  // Prevent path traversal / nested paths.
  const noSlashes = trimmed.replace(/[\\/]+/g, "-");
  const dashed = noSlashes.replace(/[^a-z0-9-_]+/g, "-");
  return dashed.replace(/^-+/, "").replace(/-+$/, "");
}

export function resolveProjectsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, "projects");
}

export function resolveProjectDir(workspaceDir: string, projectId: string): string {
  return path.join(resolveProjectsRoot(workspaceDir), projectId);
}

export async function listProjects(workspaceDir: string): Promise<string[]> {
  const root = resolveProjectsRoot(workspaceDir);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, Math.max(0, maxChars)) + "\n\n…truncated…", truncated: true };
}

async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return null;
    }
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function listInstructionFiles(projectDir: string): Promise<string[]> {
  const instructionsDir = path.join(projectDir, "instructions");
  try {
    const entries = await fs.readdir(instructionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .map((name) => path.join(instructionsDir, name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function listProjectContextFiles(
  workspaceDir: string,
  projectId: string,
  options?: ListProjectContextFilesOptions,
): Promise<ProjectContextFile[]> {
  const id = sanitizeProjectId(projectId);
  if (!id) {
    return [];
  }

  const maxFiles = Math.max(1, Math.floor(options?.maxFiles ?? DEFAULT_MAX_FILES));
  const maxCharsPerFile = Math.max(
    256,
    Math.floor(options?.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE),
  );
  const maxTotalChars = Math.max(
    512,
    Math.floor(options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS),
  );

  const projectDir = resolveProjectDir(workspaceDir, id);

  // File priority order: PROJECT.md, CONTEXT.md, then instructions/*.md
  const candidates: string[] = [];
  const projectMd = path.join(projectDir, "PROJECT.md");
  const contextMd = path.join(projectDir, "CONTEXT.md");

  candidates.push(projectMd);
  candidates.push(contextMd);

  const instructionFiles = await listInstructionFiles(projectDir);
  candidates.push(...instructionFiles);

  const results: ProjectContextFile[] = [];
  let totalChars = 0;

  for (const absPath of candidates) {
    if (results.length >= maxFiles || totalChars >= maxTotalChars) {
      break;
    }
    const raw = await readFileIfExists(absPath);
    if (!raw) {
      continue;
    }

    const clamped = clampText(raw, Math.min(maxCharsPerFile, maxTotalChars - totalChars));
    if (!clamped.text.trim()) {
      continue;
    }

    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    results.push({ path: relPath, content: clamped.text });
    totalChars += clamped.text.length;
  }

  return results;
}

export function listProjectMemoryRoots(workspaceDir: string, projectId: string): string[] {
  const id = sanitizeProjectId(projectId);
  if (!id) {
    return [];
  }
  const dir = resolveProjectDir(workspaceDir, id);
  return [
    path.join(dir, "MEMORY.md"),
    path.join(dir, "memory"),
    // allow alt name for parity with workspace
    path.join(dir, "memory.md"),
  ];
}
