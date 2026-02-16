import fs from "node:fs/promises";
import path from "node:path";

export type EnvMap = Record<string, string>;

export type ProjectEnvLoadResult = {
  variables: EnvMap;
  secrets: EnvMap;
  merged: EnvMap;
};

const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

function stripInlineComment(value: string): string {
  // Best-effort: strip trailing comments when not inside quotes.
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    // If quoted, keep the quoted segment and drop anything after it.
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        return trimmed.slice(0, i + 1).trim();
      }
    }
    // No closing quote, leave as-is.
    return trimmed;
  }

  const hash = trimmed.indexOf("#");
  if (hash === -1) {
    return trimmed;
  }
  return trimmed.slice(0, hash).trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseEnvFile(content: string): EnvMap {
  const result: EnvMap = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const match = raw.match(ENV_LINE_RE);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim();
    const valueRaw = match[2] ?? "";
    if (!key) {
      continue;
    }
    const withoutComment = stripInlineComment(valueRaw);
    const value = unquote(withoutComment);
    result[key] = value;
  }
  return result;
}

async function readEnvFileIfExists(absPath: string): Promise<EnvMap> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return {};
    }
    const content = await fs.readFile(absPath, "utf-8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
}

export function resolveProjectDir(workspaceDir: string, projectId: string): string {
  return path.join(workspaceDir, "projects", projectId);
}

export function resolveProjectEnvPaths(
  workspaceDir: string,
  projectId: string,
): {
  variablesPath: string;
  secretsPath: string;
} {
  const dir = resolveProjectDir(workspaceDir, projectId);
  return {
    variablesPath: path.join(dir, "variables.env"),
    secretsPath: path.join(dir, "secrets.env"),
  };
}

export async function loadProjectEnv(params: {
  workspaceDir: string;
  projectId: string;
}): Promise<ProjectEnvLoadResult> {
  const { variablesPath, secretsPath } = resolveProjectEnvPaths(
    params.workspaceDir,
    params.projectId,
  );
  const variables = await readEnvFileIfExists(variablesPath);
  const secrets = await readEnvFileIfExists(secretsPath);
  const merged = { ...variables, ...secrets };
  return { variables, secrets, merged };
}

export function applyEnvOverrides(params: {
  env: NodeJS.ProcessEnv;
  overrides: EnvMap;
}): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params.overrides)) {
    previous[key] = params.env[key];
    params.env[key] = value;
  }
  return () => {
    for (const [key, prev] of Object.entries(previous)) {
      if (prev === undefined) {
        delete params.env[key];
      } else {
        params.env[key] = prev;
      }
    }
  };
}

export async function applyProjectEnvOverrides(params: {
  workspaceDir: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  restore: () => void;
  loaded: ProjectEnvLoadResult;
}> {
  const env = params.env ?? process.env;
  const loaded = await loadProjectEnv({
    workspaceDir: params.workspaceDir,
    projectId: params.projectId,
  });
  const restore = applyEnvOverrides({ env, overrides: loaded.merged });
  return { restore, loaded };
}
