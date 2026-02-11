/**
 * Voice mode model router integration.
 *
 * Routes voice requests to appropriate models based on:
 * - Sensitive data detection (API keys, passwords, etc.)
 * - Complexity heuristics (question type, length, etc.)
 * - User preferences and configuration
 */

import type { VoiceRouterConfig, VoiceRouterMode } from "../config/types.voice.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";

const DEFAULT_MODE: VoiceRouterMode = "auto";
const DEFAULT_LOCAL_MODEL = "ollama/gpt-oss:120b";
const DEFAULT_CLOUD_MODEL = "openai-codex/gpt-5.3-codex";
const DEFAULT_COMPLEXITY_THRESHOLD = 5;

export type RouterDecision = {
  route: "local" | "cloud";
  reason: string;
  sensitiveDetected: boolean;
  complexityScore: number;
  model?: string;
  thinking?: string;
};

export type ResolvedRouterConfig = Required<VoiceRouterConfig>;

function normalizeLocalModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_LOCAL_MODEL;
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  return `ollama/${trimmed}`;
}

export function resolveRouterConfig(config?: VoiceRouterConfig): ResolvedRouterConfig {
  const localModel = normalizeLocalModel(config?.localModel?.trim() || DEFAULT_LOCAL_MODEL);
  return {
    mode: config?.mode ?? DEFAULT_MODE,
    detectSensitive: config?.detectSensitive ?? true,
    useComplexity: config?.useComplexity ?? true,
    localModel,
    cloudModel: config?.cloudModel?.trim() || DEFAULT_CLOUD_MODEL,
    complexityThreshold: config?.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD,
  };
}

/**
 * Sensitive data patterns that should route to local models.
 */
const SENSITIVE_PATTERNS = (() => {
  const raw = getDefaultRedactPatterns();
  const parsed: RegExp[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    try {
      if (match) {
        const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
        parsed.push(new RegExp(match[1], flags));
      } else {
        parsed.push(new RegExp(trimmed, "gi"));
      }
    } catch {
      continue;
    }
  }
  return parsed;
})();

/**
 * Keywords that indicate potentially sensitive context.
 */
const SENSITIVE_KEYWORDS = [
  "password",
  "secret",
  "credential",
  "private key",
  "api key",
  "token",
  "auth",
  "login",
  "ssn",
  "social security",
  "credit card",
  "bank account",
  "routing number",
];

/**
 * Detect sensitive data in text.
 */
export function detectSensitiveData(text: string): { detected: boolean; matches: string[] } {
  const matches: string[] = [];
  const lowerText = text.toLowerCase();

  // Check patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global patterns
    if (pattern.global) {
      pattern.lastIndex = 0;
    }
    if (pattern.test(text)) {
      // Reset again to get the actual match
      pattern.lastIndex = 0;
      matches.push(`pattern:${pattern.source.slice(0, 30)}...`);
    }
  }

  // Check keywords in context
  for (const keyword of SENSITIVE_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      // Only flag if it seems like actual sensitive data is present
      const keywordIndex = lowerText.indexOf(keyword);
      const context = text.slice(
        Math.max(0, keywordIndex - 20),
        keywordIndex + keyword.length + 50,
      );
      if (/[:=]|"\s*:|'\s*:/.test(context)) {
        matches.push(`keyword:${keyword}`);
      }
    }
  }

  return {
    detected: matches.length > 0,
    matches: [...new Set(matches)], // Dedupe
  };
}

/**
 * Complexity indicators for routing decisions.
 */
type ComplexityFactors = {
  length: number;
  questionWords: number;
  technicalTerms: number;
  multiStep: boolean;
  codeRelated: boolean;
  reasoning: boolean;
};

const QUESTION_WORDS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "explain",
  "describe",
];
const TECHNICAL_TERMS = [
  "algorithm",
  "architecture",
  "implementation",
  "optimization",
  "distributed",
  "concurrent",
  "async",
  "database",
  "api",
  "infrastructure",
  "kubernetes",
  "docker",
  "microservice",
  "scalability",
];
const MULTI_STEP_INDICATORS = [
  "first",
  "then",
  "next",
  "finally",
  "step by step",
  "and then",
  "after that",
];
const REASONING_INDICATORS = [
  "analyze",
  "compare",
  "evaluate",
  "pros and cons",
  "trade-off",
  "decision",
];

/**
 * Analyze text complexity for routing.
 */
export function analyzeComplexity(text: string): { score: number; factors: ComplexityFactors } {
  const lowerText = text.toLowerCase();
  const words = text.split(/\s+/);

  const factors: ComplexityFactors = {
    length: words.length,
    questionWords: 0,
    technicalTerms: 0,
    multiStep: false,
    codeRelated: false,
    reasoning: false,
  };

  // Count question words
  for (const qw of QUESTION_WORDS) {
    if (lowerText.includes(qw)) {
      factors.questionWords++;
    }
  }

  // Count technical terms
  for (const term of TECHNICAL_TERMS) {
    if (lowerText.includes(term)) {
      factors.technicalTerms++;
    }
  }

  // Check for multi-step indicators
  for (const indicator of MULTI_STEP_INDICATORS) {
    if (lowerText.includes(indicator)) {
      factors.multiStep = true;
      break;
    }
  }

  // Check for code-related content
  factors.codeRelated =
    /```|function|class |def |const |let |var |import |export |<\/?[a-z]+>/i.test(text);

  // Check for reasoning indicators
  for (const indicator of REASONING_INDICATORS) {
    if (lowerText.includes(indicator)) {
      factors.reasoning = true;
      break;
    }
  }

  // Calculate complexity score (0-10)
  let score = 0;

  // Length contribution (0-2)
  if (factors.length > 50) {
    score += 1;
  }
  if (factors.length > 150) {
    score += 1;
  }

  // Question complexity (0-2)
  if (factors.questionWords >= 2) {
    score += 1;
  }
  if (factors.questionWords >= 4) {
    score += 1;
  }

  // Technical depth (0-2)
  if (factors.technicalTerms >= 2) {
    score += 1;
  }
  if (factors.technicalTerms >= 5) {
    score += 1;
  }

  // Multi-step tasks (0-1)
  if (factors.multiStep) {
    score += 1;
  }

  // Code-related (0-1.5)
  if (factors.codeRelated) {
    score += 1.5;
  }

  // Reasoning required (0-1.5)
  if (factors.reasoning) {
    score += 1.5;
  }

  return {
    score: Math.min(10, Math.round(score * 10) / 10),
    factors,
  };
}

/**
 * Make a routing decision for a voice request.
 */
export function routeVoiceRequest(text: string, config: ResolvedRouterConfig): RouterDecision {
  // Fixed mode overrides
  if (config.mode === "local") {
    return {
      route: "local",
      reason: "mode=local",
      sensitiveDetected: false,
      complexityScore: 0,
      model: config.localModel,
      thinking: "none",
    };
  }

  if (config.mode === "cloud") {
    return {
      route: "cloud",
      reason: "mode=cloud",
      sensitiveDetected: false,
      complexityScore: 0,
      model: config.cloudModel || undefined,
      thinking: "medium",
    };
  }

  // Auto mode - check sensitive data first
  const sensitive = config.detectSensitive
    ? detectSensitiveData(text)
    : { detected: false, matches: [] };

  if (sensitive.detected) {
    return {
      route: "local",
      reason: `sensitive data: ${sensitive.matches.slice(0, 3).join(", ")}`,
      sensitiveDetected: true,
      complexityScore: 0,
      model: config.localModel,
      thinking: "none",
    };
  }

  // Check complexity
  const complexity = config.useComplexity
    ? analyzeComplexity(text)
    : { score: 0, factors: {} as ComplexityFactors };

  if (complexity.score >= config.complexityThreshold) {
    return {
      route: "cloud",
      reason: `complexity ${complexity.score} >= threshold ${config.complexityThreshold}`,
      sensitiveDetected: false,
      complexityScore: complexity.score,
      model: config.cloudModel || undefined,
      thinking: "xhigh",
    };
  }

  // Default to local for simple queries
  return {
    route: "local",
    reason: `complexity ${complexity.score} < threshold ${config.complexityThreshold}`,
    sensitiveDetected: false,
    complexityScore: complexity.score,
    model: config.localModel,
    thinking: "none",
  };
}
