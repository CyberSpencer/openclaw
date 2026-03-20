import { normalizeProviderId } from "./model-selection.js";

const ROUTER_FAILURE_MAX_AGE_MS = 5 * 60 * 1000;
const OPENAI_ROUTER_REASONS = new Set(["rate_limit", "rate_limited"]);

type RouterCloudFailure = {
  provider: string;
  reason: string;
  modelRef?: string;
  failedAt: number;
};

let lastRouterFailure: RouterCloudFailure | null = null;

function isOpenAIProvider(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return normalized === "openai" || normalized === "openai-codex";
}

function toModelRef(provider: string, model?: string): string | undefined {
  const trimmedModel = model?.trim();
  if (!trimmedModel) {
    return undefined;
  }
  if (trimmedModel.includes("/")) {
    return trimmedModel;
  }
  const trimmedProvider = provider.trim();
  if (!trimmedProvider) {
    return trimmedModel;
  }
  return `${trimmedProvider}/${trimmedModel}`;
}

export function recordCloudFailure(provider: string, reason: string, model?: string): void {
  if (!isOpenAIProvider(provider)) {
    return;
  }
  lastRouterFailure = {
    provider: normalizeProviderId(provider),
    reason: reason.trim().toLowerCase(),
    modelRef: toModelRef(provider, model),
    failedAt: Date.now(),
  };
}

export function recordCloudSuccess(provider: string): void {
  if (!isOpenAIProvider(provider)) {
    return;
  }
  lastRouterFailure = null;
}

export function getLastOpenAIFailureForRouter(): { reason: string; model: string } | null {
  if (!lastRouterFailure) {
    return null;
  }
  if (!isOpenAIProvider(lastRouterFailure.provider)) {
    return null;
  }
  if (!lastRouterFailure.modelRef) {
    return null;
  }
  if (!OPENAI_ROUTER_REASONS.has(lastRouterFailure.reason)) {
    return null;
  }
  if (Date.now() - lastRouterFailure.failedAt > ROUTER_FAILURE_MAX_AGE_MS) {
    lastRouterFailure = null;
    return null;
  }
  return {
    reason: lastRouterFailure.reason,
    model: lastRouterFailure.modelRef,
  };
}

export function resetCloudCircuitBreakerForTests(): void {
  lastRouterFailure = null;
}
