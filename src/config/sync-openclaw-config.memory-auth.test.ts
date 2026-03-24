import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CORE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function resolveSyncScriptPath(): string {
  return path.resolve(CORE_REPO_ROOT, "..", "scripts", "sync_openclaw_config.sh");
}

describe("sync_openclaw_config memory WAN auth cleanup", () => {
  it("removes remote.apiKey for Spark WAN embeddings when header auth is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sync-memory-auth-"));
    const contractPath = path.join(root, "workspace.env");
    const configPath = path.join(root, "openclaw.json");
    const scriptPath = resolveSyncScriptPath();

    try {
      await fs.writeFile(
        contractPath,
        [
          'DGX_ENABLED="1"',
          'DGX_ACCESS_MODE="wan"',
          'DGX_WAN_BASE_URL="https://spark-wan.example"',
          'DGX_WAN_TOKEN="${DGX_WAN_TOKEN:-}"',
          'MEMORY_SEARCH_PROVIDER="openai"',
          `CLW_WORKSPACE="${path.resolve(CORE_REPO_ROOT, "..")}"`,
        ].join("\n"),
      );
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            agents: {
              defaults: {
                memorySearch: {
                  provider: "openai",
                  remote: {
                    baseUrl: "https://spark-wan.example/embeddings/v1",
                    apiKey: "${DGX_WAN_TOKEN}",
                    headers: {
                      "X-OpenClaw-Token": "${DGX_WAN_TOKEN}",
                    },
                  },
                },
              },
            },
          },
          null,
          2,
        ),
      );

      await execFileAsync("bash", [scriptPath], {
        cwd: path.resolve(CORE_REPO_ROOT, ".."),
        env: {
          ...process.env,
          OPENCLAW_CONTRACT: contractPath,
          OPENCLAW_CONFIG: configPath,
          DGX_WAN_TOKEN: "wan-token",
          SYNC_SKIP_LAN_PROBE: "1",
        },
      });

      const synced = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey?: string;
                baseUrl?: string;
                headers?: Record<string, string>;
              };
            };
          };
        };
      };

      expect(synced.agents.defaults.memorySearch.remote.baseUrl).toBe(
        "https://spark-wan.example/embeddings/v1",
      );
      expect(synced.agents.defaults.memorySearch.remote.headers).toEqual({
        "X-OpenClaw-Token": "${DGX_WAN_TOKEN}",
        "ngrok-skip-browser-warning": "true",
      });
      expect(synced.agents.defaults.memorySearch.remote.apiKey).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
