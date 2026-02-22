import type { OpenClawConfig } from "../../config/config.js";
import { resolveRetryConfig, type RetryConfig } from "../retry.js";

export type DeliveryRetryPolicy = Required<RetryConfig> & {
  enabled: boolean;
};

const DEFAULT_RETRY: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 5000,
  jitter: 0.2,
};

function readRetryOverrides(cfg: OpenClawConfig): RetryConfig | undefined {
  return cfg.tools?.message?.delivery?.retry;
}

export function resolveDeliveryRetryPolicy(cfg: OpenClawConfig): DeliveryRetryPolicy {
  const enabled = cfg.tools?.message?.delivery?.retry?.enabled !== false;
  const resolved = resolveRetryConfig(DEFAULT_RETRY, readRetryOverrides(cfg));
  return {
    enabled,
    ...resolved,
  };
}

function readNumericField(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const next = (value as Record<string, unknown>)[key];
    if (typeof next === "number" && Number.isFinite(next)) {
      return next;
    }
  }
  return undefined;
}

function formatUnknownError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "";
  }
}

export function resolveRetryAfterMs(err: unknown): number | undefined {
  const retryAfter = readNumericField(err, ["retryAfterMs", "retryAfter"]);
  if (retryAfter !== undefined) {
    return Math.max(0, Math.floor(retryAfter));
  }
  const status = readNumericField(err, ["status", "statusCode", "code"]);
  if (status === 429) {
    return 1000;
  }
  const message = formatUnknownError(err);
  const match = /retry(?:\s+after)?\s+(\d+)(ms|s)?/i.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2]?.toLowerCase();
  return unit === "s" ? value * 1000 : value;
}

export function isRetryableDeliveryError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return false;
  }

  const status = readNumericField(err, ["status", "statusCode"]);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 425 || status === 429) {
      return true;
    }
    if (status >= 500 && status < 600) {
      return true;
    }
  }

  const msg = formatUnknownError(err).toLowerCase();
  return [
    "rate limit",
    "temporar",
    "timeout",
    "timed out",
    "econn",
    "socket hang up",
    "network",
    "unavailable",
    "try again",
  ].some((needle) => msg.includes(needle));
}
