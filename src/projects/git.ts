import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "../logging/redact.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { loadProjectEnv, resolveProjectDir } from "./env.js";

export type CloneProjectRepoParams = {
  workspaceDir: string;
  projectId: string;
  url: string;
  destSubdir?: string;
  branch?: string;
  timeoutMs?: number;
  tokenEnvKeys?: string[];
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"];

function normalizeUrl(url: string): string {
  return url.trim();
}

function isGithubUrl(url: string): boolean {
  return /github\.com[:/]/i.test(url);
}

function encodeBasicAuthToken(token: string): string {
  // GitHub supports https auth via basic with user x-access-token.
  const raw = `x-access-token:${token}`;
  return Buffer.from(raw, "utf-8").toString("base64");
}

function buildHttpExtraHeaderForToken(url: string, token: string): string {
  if (isGithubUrl(url)) {
    return `Authorization: Basic ${encodeBasicAuthToken(token)}`;
  }
  // Generic fallback.
  return `Authorization: Bearer ${token}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function cloneProjectRepo(params: CloneProjectRepoParams): Promise<{
  destDir: string;
  url: string;
  usedToken: boolean;
}> {
  const url = normalizeUrl(params.url);
  if (!url) {
    throw new Error("url required");
  }

  const projectDir = resolveProjectDir(params.workspaceDir, params.projectId);
  const destDir = path.join(projectDir, params.destSubdir?.trim() || "repo");

  if (await pathExists(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }

  await fs.mkdir(path.dirname(destDir), { recursive: true });

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenKeys = params.tokenEnvKeys?.length ? params.tokenEnvKeys : DEFAULT_TOKEN_KEYS;

  const loaded = await loadProjectEnv({
    workspaceDir: params.workspaceDir,
    projectId: params.projectId,
  });
  const token = tokenKeys
    .map((k) => loaded.secrets[k])
    .find((v) => typeof v === "string" && v.trim());

  const args: string[] = [];
  let usedToken = false;

  if (token) {
    usedToken = true;
    const header = buildHttpExtraHeaderForToken(url, token);
    // Avoid printing token via logs; only pass it as an arg.
    args.push("-c", `http.extraHeader=${header}`);
  }

  args.push("clone", "--depth", "1");
  if (params.branch?.trim()) {
    args.push("--branch", params.branch.trim());
  }
  args.push(url, destDir);

  // Add a nonce to avoid accidental caching of the process in some wrappers.
  const nonce = crypto.randomUUID();

  const result = await runCommandWithTimeout(["git", ...args], {
    timeoutMs,
    cwd: params.workspaceDir,
    env: {
      OPENCLAW_PROJECT_GIT_NONCE: nonce,
    },
  });

  if (result.code !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const scrubbed = token ? combined.split(token).join("[REDACTED_TOKEN]") : combined;
    const safe = redactSensitiveText(scrubbed);
    throw new Error(`git clone failed (code=${result.code}): ${safe}`);
  }

  return { destDir, url, usedToken };
}
