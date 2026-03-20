import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLastOpenAIFailureForRouter,
  recordCloudFailure,
  recordCloudSuccess,
  resetCloudCircuitBreakerForTests,
} from "./cloud-circuit-breaker.js";

afterEach(() => {
  vi.useRealTimers();
  resetCloudCircuitBreakerForTests();
});

describe("cloud circuit breaker router handoff", () => {
  it("returns a full provider/model ref for recent OpenAI rate limits", () => {
    recordCloudFailure("openai-codex", "rate_limit", "gpt-5.4");

    expect(getLastOpenAIFailureForRouter()).toEqual({
      reason: "rate_limit",
      model: "openai-codex/gpt-5.4",
    });
  });

  it("ignores stale or non-rate-limit failures and clears on success", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00Z"));
    recordCloudFailure("openai-codex", "auth", "gpt-5.4");
    expect(getLastOpenAIFailureForRouter()).toBeNull();

    recordCloudFailure("openai-codex", "rate_limit", "gpt-5.4");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getLastOpenAIFailureForRouter()).toBeNull();

    recordCloudFailure("openai-codex", "rate_limit", "gpt-5.4");
    recordCloudSuccess("openai-codex");
    expect(getLastOpenAIFailureForRouter()).toBeNull();
  });
});
