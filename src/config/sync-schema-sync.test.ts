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
 * When adding a new maybe_set() in the sync script:
 * - persisted keys must be in core schema/types
 * - runtime-only workspace keys must be listed in
 *   core/src/config/sync-schema-workspace-extensions.ts
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SYNC_SCHEMA_WORKSPACE_EXTENSIONS } from "./sync-schema-workspace-extensions.js";
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
  "models.providers.spark-ollama.baseUrl": "http://localhost:11434/v1",
  "models.providers.spark-ollama.endpointStrategy": "health",
  "models.providers.spark-ollama.models": [] as unknown[],
  "models.providers.nvidia.baseUrl": "https://integrate.api.nvidia.com/v1",
  "models.providers.nvidia.models": [] as unknown[],
  "agents.defaults.memorySearch.store.driver": "auto",
  "agents.defaults.memorySearch.store.qdrant.url": "http://localhost:6333",
  "agents.defaults.memorySearch.store.qdrant.endpoints": [{ url: "http://localhost:6333" }],
  "agents.defaults.memorySearch.provider": "auto",
  "agents.defaults.memorySearch.fallback": "none",
  "agents.defaults.memorySearch.remote.endpoints": [],
  "agents.defaults.memorySearch.rerank.enabled": false,
  "agents.defaults.memorySearch.rerank.candidateLimit": 20,
  "agents.defaults.memorySearch.rerank.topN": 0,
  "agents.defaults.memorySearch.rerank.failOpen": true,
  "agents.defaults.memorySearch.rerank.timeoutMs": 500,
  "agents.defaults.memorySearch.rerank.remote.endpoints": [
    { baseUrl: "http://localhost:7999/reranker/" },
  ],
  "agents.defaults.memorySearch.chunking.tokens": 512,
  "agents.defaults.memorySearch.chunking.overlap": 0,
  "dgx.accessMode": "auto",
  "dgx.resolvedAccessMode": "wan",
  "dgx.wanHeaders": {},
  "voice.mode": "spark",
  "voice.sparkTts.format": "webm",
  "voice.sparkTts.instruct": "",
  "voice.sparkTts.language": "en",
  "voice.sparkTts.speaker": "default",
  "auth.cooldowns.failureWindowHours": 1,
  "gateway.controlUi.allowInsecureAuth": false,
  "gateway.auth.token": "${OPENCLAW_GATEWAY_TOKEN}",
  "gateway.remote.token": "${OPENCLAW_GATEWAY_TOKEN}",
  "models.providers.spark-vllm.api": "openai-completions",
  "models.providers.spark-vllm.apiKey": "none",
  "models.providers.spark-vllm.baseUrl": "http://localhost:8004/v1",
  "models.providers.spark-vllm.endpointStrategy": "health",
  "models.providers.spark-vllm.endpoints": [],
  "models.providers.spark-vllm.models": [] as unknown[],
  "plugins.slots.memory": "memory-core",
  "routing.localFallbackModel": "ollama/gpt-oss:20b",
  "talk.apiKey": "${ELEVENLABS_API_KEY}",
  "agents.defaults.bootstrapMaxChars": 12000,
  "agents.defaults.bootstrapTotalMaxChars": 60000,
  "agents.defaults.bootstrapPromptTruncationWarning": "once",
  "agents.defaults.contextPruning.mode": "cache-ttl",
  "agents.defaults.contextPruning.ttl": "30m",
  "agents.defaults.contextPruning.keepLastAssistants": 3,
  "agents.defaults.contextPruning.softTrimRatio": 0.25,
  "agents.defaults.contextPruning.hardClearRatio": 0.45,
  "agents.defaults.contextPruning.minPrunableToolChars": 18000,
  "agents.defaults.contextPruning.tools.deny": ["browser", "canvas"],
  "agents.defaults.contextPruning.softTrim.maxChars": 2400,
  "agents.defaults.contextPruning.softTrim.headChars": 900,
  "agents.defaults.contextPruning.softTrim.tailChars": 900,
  "agents.defaults.contextPruning.hardClear.enabled": true,
  "agents.defaults.contextPruning.hardClear.placeholder": "[cleared]",
  "agents.defaults.compaction.mode": "safeguard",
  "agents.defaults.compaction.timeoutSeconds": 900,
  "agents.defaults.compaction.reserveTokensFloor": 24000,
  "agents.defaults.compaction.memoryFlush.enabled": true,
  "agents.defaults.compaction.memoryFlush.softThresholdTokens": 6000,
  "agents.defaults.memorySearch.model": "text-embedding-3-small",
  "agents.defaults.memorySearch.local.modelPath": "",
  "agents.defaults.memorySearch.remote.baseUrl": "http://localhost:8081/v1",
  "agents.defaults.memorySearch.remote.apiKey": "${MEMORY_SEARCH_REMOTE_API_KEY}",
  "agents.defaults.memorySearch.query.maxResults": 12,
  "agents.defaults.memorySearch.query.minScore": 0.25,
  "agents.defaults.memorySearch.rerank.model": "",
  "agents.defaults.memorySearch.rerank.remote.baseUrl": "http://localhost:7999/reranker/",
  "agents.defaults.memorySearch.store.path": "",
  "agents.defaults.memorySearch.store.qdrant.collection": "jarvis_memory_chunks",
  "agents.defaults.model.primary": "openai-codex/gpt-5.4",
  "agents.defaults.model.fallbacks": ["spark-vllm/nemotron-3-super"],
  "agents.defaults.subagents.model.primary": "anthropic/claude-sonnet-4-6",
  "agents.defaults.subagents.model.fallbacks": ["openai-codex/gpt-5.4"],
  "agents.defaults.models": { "openai/gpt-test": {} },
};

const RUNTIME_ONLY_EXTENSION_PATHS = new Set(
  Object.entries(SYNC_SCHEMA_WORKSPACE_EXTENSIONS)
    .filter(([, ext]) => ext.persistence === "runtime_only")
    .map(([pathStr]) => pathStr),
);

function isUnrecognizedIssue(message: string): boolean {
  return /unrecognized/i.test(message);
}

function extractUnrecognizedPaths(issue: {
  path: Array<string | number>;
  message: string;
}): string[] {
  if (!isUnrecognizedIssue(issue.message)) {
    return [];
  }
  const parent = issue.path.map(String).join(".");
  const keys = Array.from(issue.message.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  if (keys.length === 0) {
    return [parent].filter(Boolean);
  }
  return keys.map((key) => (parent ? `${parent}.${key}` : key));
}

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
  const extensionPlaceholder = SYNC_SCHEMA_WORKSPACE_EXTENSIONS[pathStr]?.placeholder;
  if (extensionPlaceholder !== undefined) {
    return extensionPlaceholder;
  }
  if (pathStr in PLACEHOLDERS) {
    return PLACEHOLDERS[pathStr];
  }
  if (pathStr.endsWith(".baseUrl")) {
    return "http://localhost";
  }
  if (pathStr.endsWith(".models")) {
    return [];
  }
  if (pathStr.endsWith(".endpointStrategy")) {
    return "health";
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

    // Add required sibling paths when we touch provider objects (schema requires baseUrl + models).
    for (const p of paths) {
      const providerMatch = /^models\.providers\.([^.]+)\./.exec(p);
      if (!providerMatch) {
        continue;
      }
      const provider = providerMatch[1];
      paths.add(`models.providers.${provider}.baseUrl`);
      paths.add(`models.providers.${provider}.models`);
    }

    const config: Record<string, unknown> = {};
    for (const p of paths) {
      setByPath(config, p, placeholderForPath(p));
    }

    const result = OpenClawSchema.safeParse(config);
    if (!result.success) {
      const unrecognizedIssues = result.error.issues.filter((iss) =>
        isUnrecognizedIssue(String(iss.message ?? "")),
      );
      const extracted = unrecognizedIssues.flatMap((iss) =>
        extractUnrecognizedPaths({
          path: iss.path as Array<string | number>,
          message: String(iss.message ?? ""),
        }),
      );
      if (unrecognizedIssues.length > 0 && extracted.length === 0) {
        throw new Error(
          `sync-schema guard could not parse unrecognized-key issues:\n${unrecognizedIssues
            .map((iss) => `  - ${iss.path.map(String).join(".")}: ${iss.message}`)
            .join("\n")}`,
        );
      }
      const disallowedUnrecognized = extracted.filter(
        (pathStr) => !RUNTIME_ONLY_EXTENSION_PATHS.has(pathStr),
      );
      if (disallowedUnrecognized.length > 0) {
        throw new Error(
          `sync_openclaw_config.sh writes keys not in core schema or workspace extension allowlist:\n${disallowedUnrecognized
            .toSorted()
            .map((pathStr) => `  - ${pathStr}`)
            .join("\n")}`,
        );
      }

      const nonUnrecognizedIssues = result.error.issues.filter(
        (iss) => !isUnrecognizedIssue(String(iss.message ?? "")),
      );
      if (nonUnrecognizedIssues.length > 0) {
        throw result.error;
      }
    }

    // Guardrail check: unknown typo keys must still fail fast.
    const probeConfig: Record<string, unknown> = JSON.parse(JSON.stringify(config));
    setByPath(probeConfig, "dgx.__syncSchemaUnknownProbe", "bad-key");
    const probeResult = OpenClawSchema.safeParse(probeConfig);
    expect(probeResult.success).toBe(false);
    if (!probeResult.success) {
      const probeUnrecognizedPaths = probeResult.error.issues.flatMap((iss) =>
        extractUnrecognizedPaths({
          path: iss.path as Array<string | number>,
          message: String(iss.message ?? ""),
        }),
      );
      expect(probeUnrecognizedPaths).toContain("dgx.__syncSchemaUnknownProbe");
    }
  });
});
