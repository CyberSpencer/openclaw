import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  buildAllowedModelSet,
  inferSubagentTaskClass,
  inferUniqueProviderFromConfiguredModels,
  parseModelRef,
  buildModelAliasIndex,
  normalizeModelSelection,
  normalizeProviderId,
  modelKey,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
  resolveSubagentModelChain,
  resolveSubagentSpawnModelSelection,
} from "./model-selection.js";

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen-portal");
      expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
      expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("parseModelRef", () => {
    it("should parse full model refs", () => {
      expect(parseModelRef("anthropic/claude-3-5-sonnet", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("preserves nested model ids after provider prefix", () => {
      expect(parseModelRef("nvidia/moonshotai/kimi-k2.5", "anthropic")).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
    });

    it("normalizes anthropic alias refs to canonical model ids", () => {
      expect(parseModelRef("anthropic/opus-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("opus-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("anthropic/sonnet-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      expect(parseModelRef("sonnet-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("should use default provider if none specified", () => {
      expect(parseModelRef("claude-3-5-sonnet", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("normalizes openai gpt-5.3 codex refs to openai-codex provider", () => {
      expect(parseModelRef("openai/gpt-5.3-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("gpt-5.3-codex", "openai")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("openai/gpt-5.3-codex-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex-codex",
      });
    });

    it("should return null for empty strings", () => {
      expect(parseModelRef("", "anthropic")).toBeNull();
      expect(parseModelRef("  ", "anthropic")).toBeNull();
    });

    it("should preserve openrouter/ prefix for native models", () => {
      expect(parseModelRef("openrouter/aurora-alpha", "openai")).toEqual({
        provider: "openrouter",
        model: "openrouter/aurora-alpha",
      });
    });

    it("should pass through openrouter external provider models as-is", () => {
      expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-5", "openai")).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("normalizes Vercel Claude shorthand to anthropic-prefixed model ids", () => {
      expect(parseModelRef("vercel-ai-gateway/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
      expect(parseModelRef("vercel-ai-gateway/opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4-6",
      });
    });

    it("keeps already-prefixed Vercel Anthropic models unchanged", () => {
      expect(parseModelRef("vercel-ai-gateway/anthropic/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
    });

    it("passes through non-Claude Vercel model ids unchanged", () => {
      expect(parseModelRef("vercel-ai-gateway/openai/gpt-5.2", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "openai/gpt-5.2",
      });
    });

    it("should handle invalid slash usage", () => {
      expect(parseModelRef("/", "anthropic")).toBeNull();
      expect(parseModelRef("anthropic/", "anthropic")).toBeNull();
      expect(parseModelRef("/model", "anthropic")).toBeNull();
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it("infers provider when configured model match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBe("anthropic");
    });

    it("returns undefined when configured matches are ambiguous", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "minimax/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for provider-prefixed model ids", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("infers provider for slash-containing model id when allowlist match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBe("vercel-ai-gateway");
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });
  });

  describe("buildAllowedModelSet", () => {
    it("keeps explicitly allowlisted models even when missing from bundled catalog", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedCatalog).toEqual([
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      ]);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it("accepts explicit allowlist refs absent from bundled catalog", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: "anthropic/claude-sonnet-4-6",
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
      });

      expect(result).toEqual({
        key: "anthropic/claude-sonnet-4-6",
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
    });

    it("strips trailing auth profile suffix before allowlist matching", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/@cf/openai/gpt-oss-20b": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual({
        key: "openai/@cf/openai/gpt-oss-20b",
        ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
      });
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { provider: "anthropic", model: "sonnet" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "anthropic", model: "sonnet" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/gpt-4",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("strips trailing profile suffix for simple model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "gpt-5@myprofile",
        defaultProvider: "openai",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-5" });
    });

    it("strips trailing profile suffix for provider/model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "google/gemini-flash-latest@google:bevfresh",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "google",
        model: "gemini-flash-latest",
      });
    });

    it("preserves Cloudflare @cf model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/@cf/openai/gpt-oss-20b",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openai",
        model: "@cf/openai/gpt-oss-20b",
      });
    });

    it("preserves OpenRouter @preset model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("splits trailing profile suffix after OpenRouter preset paths", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5@work",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("strips profile suffix before alias resolution", () => {
      const index = {
        byAlias: new Map([
          ["kimi", { alias: "kimi", ref: { provider: "nvidia", model: "moonshotai/kimi-k2.5" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "kimi@nvidia:default",
        defaultProvider: "openai",
        aliasIndex: index,
      });
      expect(resolved?.ref).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
      expect(resolved?.alias).toBe("kimi");
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should fall back to anthropic and warn if provider is missing for non-alias", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "claude-3-5-sonnet" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "google",
          defaultModel: "gemini-pro",
        });

        expect(result).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to "anthropic/claude-3-5-sonnet"'),
        );
      } finally {
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<OpenClawConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      });
      expect(result).toEqual({ provider: "openai", model: "gpt-4" });
    });
  });
});

describe("normalizeModelSelection", () => {
  it("returns trimmed string for string input", () => {
    expect(normalizeModelSelection("ollama/llama3.2:3b")).toBe("ollama/llama3.2:3b");
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(normalizeModelSelection("")).toBeUndefined();
    expect(normalizeModelSelection("   ")).toBeUndefined();
  });

  it("extracts primary from object", () => {
    expect(normalizeModelSelection({ primary: "google/gemini-2.5-flash" })).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns undefined for object without primary", () => {
    expect(normalizeModelSelection({ fallbacks: ["a"] })).toBeUndefined();
    expect(normalizeModelSelection({})).toBeUndefined();
  });

  it("returns undefined for null/undefined/number", () => {
    expect(normalizeModelSelection(undefined)).toBeUndefined();
    expect(normalizeModelSelection(null)).toBeUndefined();
    expect(normalizeModelSelection(42)).toBeUndefined();
  });
});

describe("subagent spawn routing", () => {
  const runtimeDirs: string[] = [];
  const originalRuntimeDir = process.env.OPENCLAW_RUNTIME_DIR;

  const baseConfig = (): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
            fallbacks: [
              "anthropic/claude-sonnet-4-6",
              "openai-codex/gpt-5.3-codex-spark",
              "spark-vllm/nemotron-3-super",
            ],
          },
          subagents: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: [
                "openai-codex/gpt-5.4",
                "openai-codex/gpt-5.3-codex-spark",
                "spark-vllm/nemotron-3-super",
              ],
            },
          },
        },
      },
    }) as OpenClawConfig;

  const unpinnedConfig = (): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
            fallbacks: [
              "anthropic/claude-sonnet-4-6",
              "openai-codex/gpt-5.3-codex-spark",
              "spark-vllm/nemotron-3-super",
            ],
          },
        },
      },
    }) as OpenClawConfig;

  afterEach(async () => {
    if (originalRuntimeDir === undefined) {
      delete process.env.OPENCLAW_RUNTIME_DIR;
    } else {
      process.env.OPENCLAW_RUNTIME_DIR = originalRuntimeDir;
    }
    await Promise.all(
      runtimeDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("infers the standard class for frontend and generic analysis work", () => {
    expect(inferSubagentTaskClass("investigate the react component rendering bug")).toBe(
      "standard",
    );
    expect(inferSubagentTaskClass("analyze the failing UI state transition")).toBe("standard");
  });

  it("infers the simple_readonly class for grep and inspection tasks", () => {
    expect(inferSubagentTaskClass("grep the repo and summarize the auth flow")).toBe(
      "simple_readonly",
    );
  });

  it("infers the fast_code class for quick narrow patches", () => {
    expect(inferSubagentTaskClass("quick narrow patch to add a unit test fixture")).toBe(
      "fast_code",
    );
  });

  it("infers the hard_code_or_review class for backend-heavy review work", () => {
    expect(inferSubagentTaskClass("review this backend api migration and security impact")).toBe(
      "hard_code_or_review",
    );
  });

  it("builds the standard chain from configured defaults", () => {
    expect(resolveSubagentModelChain("standard", baseConfig())).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.3-codex-spark",
      "spark-vllm/nemotron-3-super",
      `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
    ]);
  });

  it("builds the simple_readonly chain with spark first", () => {
    expect(resolveSubagentModelChain("simple_readonly", baseConfig())[0]).toBe(
      "spark-vllm/nemotron-3-super",
    );
  });

  it("builds the fast_code chain with codex spark first", () => {
    expect(resolveSubagentModelChain("fast_code", baseConfig())[0]).toBe(
      "openai-codex/gpt-5.3-codex-spark",
    );
  });

  it("builds the hard_code_or_review chain with gpt-5.4 first", () => {
    expect(resolveSubagentModelChain("hard_code_or_review", baseConfig())[0]).toBe(
      "openai-codex/gpt-5.4",
    );
  });

  it("preserves explicit model overrides", () => {
    const selection = resolveSubagentSpawnModelSelection({
      cfg: baseConfig(),
      agentId: "main",
      task: "review this backend change",
      modelOverride: "minimax/MiniMax-M2.1",
    });

    expect(selection).toEqual({
      model: "minimax/MiniMax-M2.1",
      route: "explicit",
      taskClass: "hard_code_or_review",
    });
  });

  it("respects agent-specific subagent model pins before task routing", () => {
    const cfg = {
      ...baseConfig(),
      agents: {
        ...baseConfig().agents,
        list: [{ id: "research", subagents: { model: "opencode/claude" } }],
      },
    } as OpenClawConfig;

    const selection = resolveSubagentSpawnModelSelection({
      cfg,
      agentId: "research",
      task: "quick narrow patch to add a unit test fixture",
    });

    expect(selection).toMatchObject({
      model: "opencode/claude",
      route: "anthropic-sonnet",
      taskClass: "fast_code",
    });
  });

  it("routes simple readonly tasks to spark first when unpinned", () => {
    const selection = resolveSubagentSpawnModelSelection({
      cfg: unpinnedConfig(),
      agentId: "main",
      task: "grep the repo and summarize the auth flow",
    });

    expect(selection).toMatchObject({
      model: "spark-vllm/nemotron-3-super",
      route: "simple_readonly",
      taskClass: "simple_readonly",
    });
  });

  it("routes fast code tasks to codex spark first when unpinned", () => {
    const selection = resolveSubagentSpawnModelSelection({
      cfg: unpinnedConfig(),
      agentId: "main",
      task: "quick narrow patch to add a unit test fixture",
    });

    expect(selection).toMatchObject({
      model: "openai-codex/gpt-5.3-codex-spark",
      route: "fast_code",
      taskClass: "fast_code",
    });
  });

  it("routes backend-heavy review tasks to gpt-5.4 first when unpinned", () => {
    const selection = resolveSubagentSpawnModelSelection({
      cfg: unpinnedConfig(),
      agentId: "main",
      task: "review this backend api migration and security impact",
    });

    expect(selection).toMatchObject({
      model: "openai-codex/gpt-5.4",
      route: "hard_code_or_review",
      taskClass: "hard_code_or_review",
    });
  });

  it("keeps agents.defaults.subagents.model as the default pin ahead of task routing", () => {
    const selection = resolveSubagentSpawnModelSelection({
      cfg: baseConfig(),
      agentId: "main",
      task: "quick narrow patch to add a unit test fixture",
    });

    expect(selection).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      route: "anthropic-sonnet",
      taskClass: "fast_code",
    });
  });

  it("uses cwd as a tiebreaker when task text is generic", () => {
    expect(inferSubagentTaskClass("investigate the failure", "/workspace/service/api")).toBe(
      "hard_code_or_review",
    );
    expect(inferSubagentTaskClass("investigate the failure", "/workspace/apps/web")).toBe(
      "standard",
    );
  });

  it("keeps existing sonnet suppression behavior and uses spark fallback", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routing-"));
    runtimeDirs.push(runtimeDir);
    await fs.mkdir(path.join(runtimeDir, "tmp"), { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "tmp", "router-anthropic-suppression.json"),
      JSON.stringify({
        per_model: {
          "anthropic/claude-sonnet-4-6": {
            suppressed_until: Math.floor(Date.now() / 1000) + 3600,
            reason: "rate_limit",
          },
        },
      }),
      "utf8",
    );
    process.env.OPENCLAW_RUNTIME_DIR = runtimeDir;

    const selection = resolveSubagentSpawnModelSelection({
      cfg: baseConfig(),
      agentId: "main",
      task: "investigate the react component rendering bug",
    });

    expect(selection).toMatchObject({
      model: "openai-codex/gpt-5.4",
      route: "anthropic-nemotron",
      rateLimitFallback: true,
      taskClass: "standard",
    });
  });

  it("falls back to routing.localFallbackModel when configured subagent fallbacks are exhausted", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routing-local-fallback-"));
    runtimeDirs.push(runtimeDir);
    await fs.mkdir(path.join(runtimeDir, "tmp"), { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "tmp", "router-anthropic-suppression.json"),
      JSON.stringify({
        blanket: {
          suppressed_until: Math.floor(Date.now() / 1000) + 3600,
          reason: "rate_limit",
        },
        per_model: {
          "anthropic/claude-sonnet-4-6": {
            suppressed_until: Math.floor(Date.now() / 1000) + 3600,
            reason: "rate_limit",
          },
        },
      }),
      "utf8",
    );
    process.env.OPENCLAW_RUNTIME_DIR = runtimeDir;

    const cfg = {
      ...baseConfig(),
      agents: {
        defaults: {
          ...baseConfig().agents?.defaults,
          subagents: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
      routing: {
        localFallbackModel: "spark-vllm/nemotron-3-super",
      },
    } as OpenClawConfig;

    const selection = resolveSubagentSpawnModelSelection({
      cfg,
      agentId: "main",
      task: "investigate the react component rendering bug",
    });

    expect(selection).toMatchObject({
      model: "spark-vllm/nemotron-3-super",
      route: "anthropic-nemotron",
      rateLimitFallback: true,
      taskClass: "standard",
    });
  });
});
