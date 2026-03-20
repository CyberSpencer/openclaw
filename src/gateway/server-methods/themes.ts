import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  findThemeByLabel,
  listThemeSummaries,
  loadThemeStore,
  normalizeThemeBrief,
  normalizeThemeLabel,
  resolveThemeLookup,
  resolveThemesStorePath,
  resolveThemeSummaryForSession,
  themeToSummary,
  updateThemeStore,
} from "../../config/themes.js";
import {
  buildAgentLaneSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  validateThemesArchiveParams,
  validateThemesCreateParams,
  validateThemesListParams,
  validateThemesPatchParams,
  validateThemesResolveParams,
  validateThemesSuggestParams,
} from "../protocol/index.js";
import {
  loadSessionEntry,
  readSessionPreviewItemsFromTranscript,
  type ThemesListResult,
  type ThemesPatchResult,
  type ThemesSuggestResult,
} from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const TOKEN_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "being",
  "could",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "need",
  "really",
  "should",
  "some",
  "that",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "want",
  "with",
  "would",
  "your",
]);

function isGatewayErrorShape(value: unknown): value is { code: string; message: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function resolveThemesAgentId(rawAgentId: unknown, sessionKey?: string): string {
  const explicit = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  if (explicit) {
    return normalizeAgentId(explicit);
  }
  const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : undefined;
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return normalizeAgentId(resolveDefaultAgentId(loadConfig()));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token.length <= 32 && !TOKEN_STOPWORDS.has(token));
}

function buildThemeVector(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const vector = new Map<string, number>();
  for (const token of tokens) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

function scoreThemeMatch(messageText: string, themeText: string) {
  const messageTokens = tokenize(messageText);
  if (messageTokens.length === 0) {
    return 0;
  }
  const themeVector = buildThemeVector(themeText);
  if (themeVector.size === 0) {
    return 0;
  }
  let matchedWeight = 0;
  for (const token of messageTokens) {
    matchedWeight += themeVector.get(token) ?? 0;
  }
  const overlap = matchedWeight / Math.max(messageTokens.length, 1);
  const compactTheme = themeText.toLowerCase();
  const phraseBonus = compactTheme && messageText.toLowerCase().includes(compactTheme) ? 0.2 : 0;
  return Math.max(0, Math.min(1, overlap + phraseBonus));
}

function truncateSummary(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trim()}…`;
}

function buildSuggestionLabel(message: string) {
  const compact = truncateSummary(message, 48)
    .replace(/[:.,;!?]+$/g, "")
    .trim();
  if (!compact) {
    return "New lane";
  }
  return compact;
}

function buildSuggestionBrief(message: string) {
  return truncateSummary(message, 120);
}

function resolveRecentContextText(sessionKey: string): string {
  const loaded = loadSessionEntry(sessionKey);
  const sessionId = loaded.entry?.sessionId;
  if (!sessionId) {
    return "";
  }
  const items = readSessionPreviewItemsFromTranscript(
    sessionId,
    loaded.storePath,
    loaded.entry?.sessionFile,
    loaded.canonicalKey
      ? normalizeAgentId(parseAgentSessionKey(loaded.canonicalKey)?.agentId)
      : undefined,
    6,
    240,
  );
  return items.map((item) => item.text).join("\n");
}

function resolveSuggestResult(params: {
  currentThemeText: string;
  currentTheme?: ReturnType<typeof resolveThemeSummaryForSession>;
  candidateThemes: ReturnType<typeof listThemeSummaries>;
  message: string;
  recentText: string;
}): ThemesSuggestResult {
  const message = params.message.trim();
  const combinedMessage = [message, params.recentText].filter(Boolean).join("\n");
  const tokenCount = tokenize(message).length;
  if (message.length < 24 || tokenCount < 4) {
    return {
      ok: true,
      action: params.currentTheme ? "stay" : "no_confident_suggestion",
      confidence: 0.2,
      currentTheme: params.currentTheme,
      reason: "message-too-short",
    };
  }

  const currentScore = params.currentTheme
    ? scoreThemeMatch(combinedMessage, params.currentThemeText)
    : 0;
  const scoredCandidates = params.candidateThemes
    .filter((theme) => theme.id !== params.currentTheme?.id)
    .map((theme) => ({
      theme,
      score: scoreThemeMatch(combinedMessage, [theme.label, theme.brief].filter(Boolean).join(" ")),
    }))
    .toSorted((a, b) => b.score - a.score);
  const bestCandidate = scoredCandidates[0];

  if (
    bestCandidate &&
    bestCandidate.score >= 0.5 &&
    (!params.currentTheme || bestCandidate.score - currentScore >= 0.18)
  ) {
    return {
      ok: true,
      action: "switch_to_existing_lane",
      confidence: Math.max(bestCandidate.score, 0.55),
      currentTheme: params.currentTheme,
      suggestedTheme: bestCandidate.theme,
      reason: "strong-existing-theme-match",
    };
  }

  if (params.currentTheme && currentScore >= 0.36) {
    return {
      ok: true,
      action: "stay",
      confidence: Math.max(0.4, currentScore),
      currentTheme: params.currentTheme,
      reason: "current-theme-still-fits",
    };
  }

  if (tokenCount >= 8 && (!bestCandidate || bestCandidate.score < 0.4)) {
    return {
      ok: true,
      action: "create_new_lane",
      confidence: 0.52,
      currentTheme: params.currentTheme,
      suggestedLabel: buildSuggestionLabel(message),
      suggestedBrief: buildSuggestionBrief(message),
      reason: "new-topic-pattern",
    };
  }

  return {
    ok: true,
    action: params.currentTheme ? "stay" : "no_confident_suggestion",
    confidence: params.currentTheme ? Math.max(0.25, currentScore) : 0.2,
    currentTheme: params.currentTheme,
    reason: "low-confidence",
  };
}

export const themesHandlers: GatewayRequestHandlers = {
  "themes.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesListParams, "themes.list", respond)) {
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveThemesAgentId(params.agentId);
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    const store = loadThemeStore(storePath);
    const themes = listThemeSummaries(store, {
      includeArchived: params.includeArchived === true,
      search: typeof params.search === "string" ? params.search : undefined,
    });
    const result: ThemesListResult = {
      ts: Date.now(),
      path: storePath,
      count: themes.length,
      themes,
    };
    respond(true, result, undefined);
  },
  "themes.resolve": ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesResolveParams, "themes.resolve", respond)) {
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveThemesAgentId(
      params.agentId,
      typeof params.sessionKey === "string" ? params.sessionKey : undefined,
    );
    if (typeof params.sessionKey === "string" && params.sessionKey.trim()) {
      const theme = resolveThemeSummaryForSession({
        cfg,
        sessionKey: params.sessionKey,
        includeArchived: params.includeArchived === true,
      });
      if (!theme) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "theme not found"));
        return;
      }
      respond(
        true,
        { ok: true, path: resolveThemesStorePath(cfg.session?.store, { agentId }), theme },
        undefined,
      );
      return;
    }
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    const store = loadThemeStore(storePath);
    const match = resolveThemeLookup(store, {
      id: typeof params.id === "string" ? params.id : undefined,
      label: typeof params.label === "string" ? params.label : undefined,
      includeArchived: params.includeArchived === true,
    });
    if (!match) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "theme not found"));
      return;
    }
    respond(
      true,
      { ok: true, path: storePath, theme: themeToSummary(match.id, match.entry) },
      undefined,
    );
  },
  "themes.create": async ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesCreateParams, "themes.create", respond)) {
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveThemesAgentId(params.agentId);
    const label = normalizeThemeLabel(params.label);
    if (!label) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label required"));
      return;
    }
    const brief = normalizeThemeBrief(params.brief);
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    try {
      const theme = await updateThemeStore(storePath, (store) => {
        if (findThemeByLabel(store, label)) {
          throw errorShape(ErrorCodes.INVALID_REQUEST, `theme label already in use: ${label}`);
        }
        const id = randomUUID();
        const now = Date.now();
        const entry = {
          label,
          brief,
          status: "active" as const,
          canonicalSessionKey: buildAgentLaneSessionKey({ agentId, themeId: id }),
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        };
        store[id] = entry;
        return themeToSummary(id, entry);
      });
      const result: ThemesPatchResult = {
        ok: true,
        path: storePath,
        theme,
      };
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        isGatewayErrorShape(error) ? error : errorShape(ErrorCodes.UNAVAILABLE, String(error)),
      );
    }
  },
  "themes.patch": async ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesPatchParams, "themes.patch", respond)) {
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveThemesAgentId(params.agentId);
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    try {
      const theme = await updateThemeStore(storePath, (store) => {
        const entry = store[params.id];
        if (!entry) {
          throw errorShape(ErrorCodes.INVALID_REQUEST, "theme not found");
        }
        if ("label" in params) {
          if (params.label === null) {
            throw errorShape(ErrorCodes.INVALID_REQUEST, "theme label cannot be cleared");
          }
          const nextLabel = normalizeThemeLabel(params.label);
          if (!nextLabel) {
            throw errorShape(ErrorCodes.INVALID_REQUEST, "invalid theme label");
          }
          const existing = findThemeByLabel(store, nextLabel);
          if (existing && existing.id !== params.id) {
            throw errorShape(
              ErrorCodes.INVALID_REQUEST,
              `theme label already in use: ${nextLabel}`,
            );
          }
          entry.label = nextLabel;
        }
        if ("brief" in params) {
          const nextBrief =
            params.brief === null ? undefined : normalizeThemeBrief(params.brief ?? undefined);
          if (nextBrief) {
            entry.brief = nextBrief;
          } else {
            delete entry.brief;
          }
        }
        entry.updatedAt = Date.now();
        return themeToSummary(params.id, entry);
      });
      const result: ThemesPatchResult = { ok: true, path: storePath, theme };
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        isGatewayErrorShape(error) ? error : errorShape(ErrorCodes.UNAVAILABLE, String(error)),
      );
    }
  },
  "themes.archive": async ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesArchiveParams, "themes.archive", respond)) {
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveThemesAgentId(params.agentId);
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    try {
      const theme = await updateThemeStore(storePath, (store) => {
        const match = resolveThemeLookup(store, {
          id: typeof params.id === "string" ? params.id : undefined,
          label: typeof params.label === "string" ? params.label : undefined,
          includeArchived: true,
        });
        if (!match) {
          throw errorShape(ErrorCodes.INVALID_REQUEST, "theme not found");
        }
        match.entry.status = "archived";
        match.entry.updatedAt = Date.now();
        return themeToSummary(match.id, match.entry);
      });
      const result: ThemesPatchResult = { ok: true, path: storePath, theme };
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        isGatewayErrorShape(error) ? error : errorShape(ErrorCodes.UNAVAILABLE, String(error)),
      );
    }
  },
  "themes.suggest": ({ params, respond }) => {
    if (!assertValidParams(params, validateThemesSuggestParams, "themes.suggest", respond)) {
      return;
    }
    const cfg = loadConfig();
    const sessionKey = params.sessionKey.trim();
    const agentId = resolveThemesAgentId(params.agentId, sessionKey);
    const storePath = resolveThemesStorePath(cfg.session?.store, { agentId });
    const store = loadThemeStore(storePath);
    const currentTheme = resolveThemeSummaryForSession({ cfg, sessionKey, includeArchived: false });
    const recentText = resolveRecentContextText(sessionKey);
    const result = resolveSuggestResult({
      currentTheme,
      currentThemeText: currentTheme
        ? [currentTheme.label, currentTheme.brief].filter(Boolean).join(" ")
        : "",
      candidateThemes: listThemeSummaries(store, { includeArchived: false }).slice(
        0,
        typeof params.limit === "number" ? params.limit : 8,
      ),
      message: params.message,
      recentText,
    });
    respond(true, result, undefined);
  },
};
