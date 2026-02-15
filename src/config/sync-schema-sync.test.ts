/**
 * Schema-sync guard: ensures keys written by scripts/sync_openclaw_config.sh
 * are recognized by the OpenClaw Zod schema. Prevents "Unrecognized key" startup failures.
 *
 * In Spencer's workspace layout, openclaw-core lives at:
 *   <workspace>/core
 * and the sync script lives at:
 *   <workspace>/scripts/sync_openclaw_config.sh
 *
 * In standalone checkouts/CI of the openclaw-core repo, that workspace-level script may not exist.
 * In that case we skip this guard (it is still enforced in the workspace where the script exists).
 *
 * When adding a new maybe_set() in the sync script, also add the key to the
 * Zod schema (core/src/config/zod-schema.ts) and TypeScript types.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const CORE_REPO_ROOT = path.resolve(import.meta.dirname, "../..", ".."); // <repo>/src/config -> <repo>

const SYNC_SCRIPT_CANDIDATES = [
  // Spencer workspace layout: <workspace>/core (this repo), script at <workspace>/scripts/...
  path.resolve(CORE_REPO_ROOT, "..", "scripts", "sync_openclaw_config.sh"),

  // If the script is ever vendored into this repo
  path.resolve(CORE_REPO_ROOT, "scripts", "sync_openclaw_config.sh"),
];

function findSyncScript(): string | null {
  for (const p of SYNC_SCRIPT_CANDIDATES) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/** Placeholder values for paths that need specific schema shapes (enums, min values, etc). */
const PLACEHOLDERS: Record<string, unknown> = {
  "gateway.port": 32555,
  "gateway.bind": "auto",
  "gateway.controlUi.root": "dist/control-ui",
  "models.providers.ollama.baseUrl": "http://localhost:11434",
  "models.providers.ollama.endpointStrategy": "health",
  "models.providers.ollama.endpoints": [],
  "models.providers.ollama.models": [] as unknown[],
  "agents.defaults.memorySearch.store.driver": "auto",
  "agents.defaults.memorySearch.store.qdrant.url": "http://localhost:6333",
  "agents.defaults.memorySearch.store.qdrant.endpoints": [{ url: "http://localhost:6333" }],
  "agents.defaults.memorySearch.provider": "auto",
  "agents.defaults.memorySearch.fallback": "none",
  "agents.defaults.memorySearch.remote.endpoints": [],
  "agents.defaults.memorySearch.chunking.tokens": 512,
  "agents.defaults.memorySearch.chunking.overlap": 0,
  "dgx.accessMode": "auto",
  "dgx.wanHeaders": {},
  "voice.mode": "spark",
  "voice.sparkTts.format": "webm",
};

function setByPath(obj: Record<string, unknown>, pathStr: string, value: unknown): void {
  const parts = pathStr.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in cur) || typeof cur[key] !== "object" || cur[key] === null) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  cur[leaf] = value;
}

function placeholderForPath(pathStr: string): unknown {
  if (pathStr in PLACEHOLDERS) {
    return PLACEHOLDERS[pathStr];
  }
  if (pathStr.endsWith(".endpoints") || pathStr.endsWith(".fallbacks")) {
    return [];
  }
  if (pathStr.endsWith(".headers") || pathStr.includes("wanHeaders")) {
    return {};
  }
  if (pathStr.includes("port") || pathStr.includes("tokens") || pathStr.includes("overlap")) {
    return 0;
  }
  return "";
}

describe("sync_openclaw_config schema sync", () => {
  it("accepts all keys written by sync_openclaw_config.sh", () => {
    const syncScript = findSyncScript();
    if (!syncScript) {
      // Standalone core checkout (e.g. CI) may not have the workspace-level ops scripts.
      // This guard is primarily for the workspace layout where sync_openclaw_config.sh is used.
      return;
    }

    const script = fs.readFileSync(syncScript, "utf-8");
    const maybeSetRe = /maybe_set\s*\(\s*["']([^"']+)["']/g;
    const paths = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = maybeSetRe.exec(script)) !== null) {
      paths.add(m[1]);
    }

    expect(paths.size).toBeGreaterThan(0);

    // Add required sibling paths when we touch certain objects (schema requires them).
    for (const p of paths) {
      if (p.startsWith("models.providers.ollama.")) {
        paths.add("models.providers.ollama.models");
        break;
      }
    }

    const config: Record<string, unknown> = {};
    for (const p of paths) {
      setByPath(config, p, placeholderForPath(p));
    }

    const result = OpenClawSchema.safeParse(config);

    if (!result.success) {
      const unrecognized = result.error.issues.filter(
        (iss) =>
          typeof iss.message === "string" &&
          (iss.message.includes("Unrecognized") || iss.message.includes("unrecognized")),
      );
      if (unrecognized.length > 0) {
        const details = unrecognized
          .map((iss) => `  - ${iss.path.map(String).join(".")}: ${iss.message}`)
          .join("\n");
        throw new Error(
          `sync_openclaw_config.sh writes keys not in the Zod schema. Add them to core/src/config/zod-schema.ts and types:\n${details}`,
        );
      }
      throw result.error;
    }
  });
});
