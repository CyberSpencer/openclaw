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

describe("sync_openclaw_config subagent model inheritance", () => {
  it("syncs subagent defaults to the main Kimi-first fallback chain by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sync-subagents-"));
    const contractPath = path.join(root, "workspace.env");
    const configPath = path.join(root, "openclaw.json");
    const scriptPath = resolveSyncScriptPath();

    try {
      await fs.writeFile(
        contractPath,
        [
          'OPENCLAW_MODEL_PRIMARY="openai-codex/gpt-5.4"',
          'OPENCLAW_MODEL_FALLBACKS="nvidia/moonshotai/kimi-k2.5,spark-ollama/gpt-oss:120b,ollama/gpt-oss:20b"',
          `CLW_WORKSPACE="${path.resolve(CORE_REPO_ROOT, "..")}"`,
        ].join("\n"),
      );
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            agents: {
              defaults: {
                subagents: {
                  model: {
                    primary: "openai-codex/gpt-5.4",
                    fallbacks: ["spark-ollama/gpt-oss:120b", "ollama/gpt-oss:20b"],
                  },
                },
              },
            },
          },
          null,
          2,
        ),
      );

      const { stdout } = await execFileAsync("bash", [scriptPath, "--dry-run"], {
        cwd: path.resolve(CORE_REPO_ROOT, ".."),
        env: {
          ...process.env,
          OPENCLAW_CONTRACT: contractPath,
          OPENCLAW_CONFIG: configPath,
        },
      });

      expect(stdout).toContain("agents.defaults.subagents.model.fallbacks");
      expect(stdout).toContain(
        "['nvidia/moonshotai/kimi-k2.5', 'spark-ollama/gpt-oss:120b', 'ollama/gpt-oss:20b']",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
