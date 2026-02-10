import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { loadConfig } from "../../config/config.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "../auth-profiles.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { isCliProvider, normalizeProviderId } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { resolveProviderEndpointConfig } from "../provider-endpoints.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  classifyFailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  parseImageSizeError,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTransientNetworkErrorMessage,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";
import { normalizeUsage, type UsageLike } from "../usage.js";
import { runCliAgent } from "../cli-runner.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveMemorySearchConfig } from "../memory-search.js";

import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import {
  truncateOversizedToolResultsInSession,
  sessionLikelyHasOversizedToolResults,
} from "./tool-result-truncation.js";
import { describeUnknownError } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

// Avoid Anthropic's refusal test token poisoning session transcripts.
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

type RouterDecision = {
  target?: string;
  mode?: string;
  model?: string;
  thinking?: string;
  reason?: string;
  sensitive?: boolean;
  fallback_chain?: string[];
};

async function buildMemoryPrelude(params: {
  cfg?: RunEmbeddedPiAgentParams["config"];
  agentId: string;
  prompt: string;
}): Promise<string> {
  if (!params.cfg) {
    return "";
  }
  const resolved = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!resolved?.enabled) {
    return "";
  }
  const { manager } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!manager) {
    return "";
  }
  let results: Awaited<ReturnType<typeof manager.search>> = [];
  try {
    const maxResults = Math.min(20, resolved.query.maxResults ?? 20);
    const minScore = Math.max(0.2, resolved.query.minScore ?? 0.2);
    results = await manager.search(params.prompt, { maxResults, minScore });
  } catch {
    return "";
  }
  if (!results.length) {
    return "";
  }
  const lines = results.map((entry, idx) => {
    const snippet = redactSensitiveText(entry.snippet, { mode: "tools" })
      .replace(/\s+/g, " ")
      .trim();
    const short = snippet.length > 500 ? `${snippet.slice(0, 497)}...` : snippet;
    return `- ${idx + 1}. ${entry.path}:${entry.startLine}-${entry.endLine} (${entry.source}, score=${entry.score.toFixed(3)}) ${short}`;
  });

  const snippetBlocks: string[] = [];
  const topSnippets = results.slice(0, 6);
  for (const entry of topSnippets) {
    const lineCount = Math.min(12, Math.max(1, entry.endLine - entry.startLine + 1));
    try {
      const file = await manager.readFile({
        relPath: entry.path,
        from: entry.startLine,
        lines: lineCount,
      });
      const cleaned = redactSensitiveText(file.text, { mode: "tools" }).trim();
      if (cleaned) {
        snippetBlocks.push(`### ${entry.path}:${entry.startLine}-${entry.endLine}`);
        snippetBlocks.push(cleaned);
      }
    } catch {
      continue;
    }
  }

  const sections = ["## Memory Search Results", ...lines];
  if (snippetBlocks.length > 0) {
    sections.push("## Memory Snippets (top 6)");
    sections.push(...snippetBlocks);
  }
  return sections.join("\n");
}

function parseRouterModel(raw?: string): { provider: string; modelId: string } | null {
  if (!raw) {
    return null;
  }
  const idx = raw.indexOf("/");
  if (idx <= 0 || idx === raw.length - 1) {
    return null;
  }
  return { provider: raw.slice(0, idx), modelId: raw.slice(idx + 1) };
}

function resolveRouterCliOverride(
  decision: RouterDecision | null,
  cfg?: RunEmbeddedPiAgentParams["config"],
): { provider?: string; modelId?: string } {
  const target = decision?.target?.trim().toLowerCase();
  const model = decision?.model?.trim();
  if (target === "cursor") {
    const provider = "cursor-cli";
    if (isCliProvider(provider, cfg)) {
      return { provider, modelId: "default" };
    }
  }
  if (model && !model.includes("/") && model.endsWith("-cli")) {
    if (isCliProvider(model, cfg)) {
      return { provider: model, modelId: "default" };
    }
  }
  return {};
}

function mapRouterThinking(value?: string): ThinkLevel | undefined {
  if (!value) {
    return undefined;
  }
  switch (value) {
    case "none":
      return "off";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

async function runModelRouter(params: {
  workspaceDir: string;
  prompt: string;
  mode: "text" | "voice";
  timeoutMs?: number;
}): Promise<RouterDecision | null> {
  const scriptPath = path.join(params.workspaceDir, "scripts", "route.sh");
  let resolvedScriptPath: string;
  try {
    await fs.access(scriptPath);
    const [realWorkspaceDir, realScriptPath] = await Promise.all([
      fs.realpath(params.workspaceDir),
      fs.realpath(scriptPath),
    ]);
    const rel = path.relative(realWorkspaceDir, realScriptPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      log.warn("router script is not contained within workspaceDir; refusing to execute");
      return null;
    }
    resolvedScriptPath = realScriptPath;
  } catch {
    return null;
  }

  const timeoutMs = params.timeoutMs ?? 2500;
  return new Promise((resolve) => {
    const child = spawn(resolvedScriptPath, ["--json", "--mode", params.mode], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        if (stderr.trim()) {
          log.warn(`router failed (${code}): ${stderr.trim().slice(0, 200)}`);
        }
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as RouterDecision;
        resolve(parsed);
      } catch (err) {
        log.warn(`router JSON parse failed: ${String(err).slice(0, 200)}`);
        resolve(null);
      }
    });

    try {
      child.stdin.write(params.prompt);
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      const prevCwd = process.cwd();

      const shouldApplyRouter = params.disableModelRouter !== true;
      const routerDecision = shouldApplyRouter
        ? await runModelRouter({
            workspaceDir: resolvedWorkspace,
            prompt: params.prompt,
            mode: "text",
          })
        : null;
      const routedThinkLevel = mapRouterThinking(routerDecision?.thinking);
      const routedModel = parseRouterModel(routerDecision?.model);
      const cliOverride = resolveRouterCliOverride(routerDecision, params.config);
      const requestedProvider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const requestedModelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

      const provider =
        (shouldApplyRouter
          ? (cliOverride.provider ?? routedModel?.provider ?? requestedProvider)
          : requestedProvider
        ).trim() || DEFAULT_PROVIDER;
      const modelId =
        (shouldApplyRouter
          ? (cliOverride.modelId ?? routedModel?.modelId ?? requestedModelId)
          : requestedModelId
        ).trim() || DEFAULT_MODEL;
      const initialThinkLevel =
        params.thinkLevel ?? (shouldApplyRouter ? routedThinkLevel : undefined) ?? "off";
      const routerMode = shouldApplyRouter ? routerDecision?.mode?.trim().toLowerCase() : undefined;
      const routerTarget = shouldApplyRouter
        ? routerDecision?.target?.trim().toLowerCase()
        : undefined;
      const isCli = isCliProvider(provider, params.config);

      if (routerTarget === "cursor" && !isCli) {
        log.warn(
          'router target "cursor" requested but no cursor-cli backend is configured, falling back to embedded LLM',
        );
      }

      if (routerMode && routerMode !== "plan" && !isCli) {
        log.warn(
          `router mode "${routerMode}" requested but embedded runner only supports model overrides; continuing with ${provider}/${modelId}`,
        );
      }

      if (isCli) {
        if (routerDecision) {
          log.info(
            `router decision: ${routerDecision.reason ?? "unknown"} -> ${provider}/${modelId} (sensitive=${routerDecision.sensitive ? "yes" : "no"})`,
          );
        }
        if (params.onAssistantMessageStart) {
          await params.onAssistantMessageStart();
        }
        return runCliAgent({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          workspaceDir: resolvedWorkspace,
          config: params.config,
          prompt: params.prompt,
          provider,
          model: modelId,
          thinkLevel: initialThinkLevel,
          timeoutMs: params.timeoutMs,
          runId: params.runId,
          extraSystemPrompt: params.extraSystemPrompt,
          ownerNumbers: params.ownerNumbers,
          images: params.images,
        });
      }
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      const baseCfg = params.config ?? loadConfig();
      const { cfg: resolvedCfg } = await resolveProviderEndpointConfig({
        cfg: baseCfg,
        providerId: provider,
      });
      const effectiveCfg = resolvedCfg ?? baseCfg;
      const fallbackConfigured =
        (effectiveCfg?.agents?.defaults?.model?.fallbacks?.length ?? 0) > 0;
      await ensureOpenClawModelsJson(effectiveCfg, agentDir);

      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        effectiveCfg,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }

      const ctxInfo = resolveContextWindowInfo({
        cfg: effectiveCfg,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      if (ctxGuard.shouldBlock) {
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const preferredProfileId = params.authProfileId?.trim();
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      const profileOrder = resolveAuthProfileOrder({
        cfg: effectiveCfg,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined];
      let profileIndex = 0;

      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;
      if (routerDecision && routedModel) {
        log.info(
          `router decision: ${routerDecision.reason ?? "unknown"} -> ${provider}/${modelId} (sensitive=${routerDecision.sensitive ? "yes" : "no"})`,
        );
      }

      const resolveAuthProfileFailoverReason = (params: {
        allInCooldown: boolean;
        message: string;
      }): FailoverReason => {
        if (params.allInCooldown) {
          return "rate_limit";
        }
        const classified = classifyFailoverReason(params.message);
        return classified ?? "auth";
      };

      const throwAuthProfileFailover = (params: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          params.message?.trim() ||
          (params.error ? describeUnknownError(params.error).trim() : "") ||
          fallbackMessage;
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: params.allInCooldown,
          message,
        });
        if (fallbackConfigured) {
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: params.error,
          });
        }
        if (params.error instanceof Error) {
          throw params.error;
        }
        throw new Error(message);
      };

      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: effectiveCfg,
          profileId: candidate,
          store: authStore,
          agentDir,
        });
      };

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
        if (!apiKeyInfo.apiKey) {
          if (apiKeyInfo.mode !== "aws-sdk") {
            throw new Error(
              `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
            );
          }
          lastProfileId = resolvedProfileId;
          return;
        }
        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
        } else {
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        if (lockedProfileId) {
          return false;
        }
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch (err) {
            if (candidate && candidate === lockedProfileId) {
              throw err;
            }
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          if (
            candidate &&
            candidate !== lockedProfileId &&
            isProfileInCooldown(authStore, candidate)
          ) {
            profileIndex += 1;
            continue;
          }
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        if (err instanceof FailoverError) {
          throw err;
        }
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      let overflowCompactionAttempted = false;
      let memoryPrelude: string | undefined;
      try {
        while (true) {
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          const prompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;
          if (memoryPrelude === undefined) {
            const memoryAgentId = resolveSessionAgentId({
              sessionKey: params.sessionKey,
              config: params.config,
            });
            memoryPrelude = await buildMemoryPrelude({
              cfg: params.config,
              agentId: memoryAgentId,
              prompt,
            });
          }
          const mergedExtraPrompt = [params.extraSystemPrompt, memoryPrelude]
            .filter((entry) => entry && String(entry).trim().length > 0)
            .join("\n\n");

          const attempt = await runEmbeddedAttempt({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderIsOwner: params.senderIsOwner,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            disableTools: params.disableTools,
            provider,
            modelId,
            model,
            authStorage,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            thinkLevel,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: mergedExtraPrompt || params.extraSystemPrompt,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
          });

          const { aborted, promptError, timedOut, sessionIdUsed, lastAssistant } = attempt;
          mergeUsageIntoAccumulator(
            usageAccumulator,
            attempt.attemptUsage ?? normalizeUsage(lastAssistant?.usage as UsageLike),
          );
          autoCompactionCount += Math.max(0, attempt.compactionCount ?? 0);
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
              })
            : undefined;
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = describeUnknownError(promptError);
                  if (isContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // Prompt submission failed with a non-overflow error. Do not
                  // inspect prior assistant errors from history for this attempt.
                  return null;
                }
                if (assistantErrorText && isContextOverflowError(assistantErrorText)) {
                  return { text: assistantErrorText, source: "assistantError" as const };
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `compactionAttempts=${overflowCompactionAttempts} error=${errorText.slice(0, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            // Attempt auto-compaction on context overflow (not compaction_failure)
            if (
              !isCompactionFailure &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              const compactResult = await compactEmbeddedPiSessionDirect({
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                messageChannel: params.messageChannel,
                messageProvider: params.messageProvider,
                agentAccountId: params.agentAccountId,
                authProfileId: lastProfileId,
                sessionFile: params.sessionFile,
                workspaceDir: resolvedWorkspace,
                agentDir,
                config: params.config,
                skillsSnapshot: params.skillsSnapshot,
                senderIsOwner: params.senderIsOwner,
                provider,
                model: modelId,
                thinkLevel,
                reasoningLevel: params.reasoningLevel,
                bashElevated: params.bashElevated,
                extraSystemPrompt: params.extraSystemPrompt,
                ownerNumbers: params.ownerNumbers,
              });
              if (compactResult.compacted) {
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            // Fallback: try truncating oversized tool results in the session.
            // This handles the case where a single tool result exceeds the
            // context window and compaction cannot reduce it further.
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                  })
                : false;

              if (hasOversized) {
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: params.sessionFile,
                  contextWindowTokens,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  // Session is now smaller; allow compaction retries again.
                  overflowCompactionAttempts = 0;
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              }
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try again with less input or a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: {
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                },
                systemPromptReport: attempt.systemPromptReport,
                error: { kind, message: errorText },
              },
            };
          }

          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            // Handle image size errors with a user-friendly message (no retry needed)
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: {
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                  },
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason = classifyFailoverReason(errorText);
            if (promptFailoverReason && promptFailoverReason !== "network" && lastProfileId) {
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason: promptFailoverReason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
            }
            if (
              isFailoverErrorMessage(errorText) &&
              promptFailoverReason !== "network" &&
              (await advanceAuthProfile())
            ) {
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // FIX: Throw FailoverError for prompt errors when fallbacks configured
            // This enables model fallback for quota/rate limit errors during prompt submission
            if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status: resolveFailoverStatus(promptFailoverReason ?? "unknown"),
              });
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const billingFailure = isBillingAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");

          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          // Treat timeout as potential rate limit (Antigravity hangs on rate limit)
          const shouldRotate = (!aborted && failoverFailure) || timedOut;

          if (shouldRotate) {
            if (lastProfileId) {
              const reason =
                timedOut || assistantFailoverReason === "network"
                  ? "timeout"
                  : (assistantFailoverReason ?? "unknown");
              await markAuthProfileFailure({
                store: authStore,
                profileId: lastProfileId,
                reason,
                cfg: params.config,
                agentDir: params.agentDir,
              });
              if (timedOut && !isProbeSession) {
                log.warn(
                  `Profile ${lastProfileId} timed out (possible rate limit). Trying next account...`,
                );
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }

            const rotated = await advanceAuthProfile();
            if (rotated) {
              continue;
            }

            if (fallbackConfigured) {
              // Prefer formatted error message (user-friendly) over raw errorMessage
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : billingFailure
                      ? BILLING_ERROR_USER_MESSAGE
                      : authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTransientNetworkErrorMessage(message) ? 408 : undefined);
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
              });
            }
          }

          const usage = toNormalizedUsage(usageAccumulator);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
          };

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            inlineToolResultsAllowed: false,
          });

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              // Handle client tool calls (OpenResponses hosted tools)
              stopReason: attempt.clientToolCall ? "tool_calls" : undefined,
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: `call_${Date.now()}`,
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
          };
        }
      } finally {
        process.chdir(prevCwd);
      }
    }),
  );
}
