import { describe, expect, it } from "vitest";
import {
  FAILURE_COOLDOWN_THRESHOLDS,
  getCronJobFailureDiagnostics,
  isFailureGrounded,
  resolveFailureCooldownMs,
  resolveFailureStreakBand,
} from "./failure-grounding.js";

describe("resolveFailureCooldownMs", () => {
  it("returns 0 when below all thresholds", () => {
    expect(resolveFailureCooldownMs(0)).toBe(0);
    expect(resolveFailureCooldownMs(1)).toBe(0);
    expect(resolveFailureCooldownMs(2)).toBe(0);
  });

  it("returns 15min cooldown at 3 consecutive failures", () => {
    expect(resolveFailureCooldownMs(3)).toBe(15 * 60_000);
  });

  it("returns 15min cooldown at 4 consecutive failures (still in the 3-band)", () => {
    expect(resolveFailureCooldownMs(4)).toBe(15 * 60_000);
  });

  it("returns 60min cooldown at 5 consecutive failures", () => {
    expect(resolveFailureCooldownMs(5)).toBe(60 * 60_000);
  });

  it("returns 60min cooldown above 5 consecutive failures", () => {
    expect(resolveFailureCooldownMs(6)).toBe(60 * 60_000);
    expect(resolveFailureCooldownMs(10)).toBe(60 * 60_000);
    expect(resolveFailureCooldownMs(100)).toBe(60 * 60_000);
  });

  it("thresholds match FAILURE_COOLDOWN_THRESHOLDS constants", () => {
    const t3 = FAILURE_COOLDOWN_THRESHOLDS.find((t) => t.after === 3);
    const t5 = FAILURE_COOLDOWN_THRESHOLDS.find((t) => t.after === 5);
    expect(t3?.cooldownMs).toBe(15 * 60_000);
    expect(t5?.cooldownMs).toBe(60 * 60_000);
  });
});

describe("resolveFailureStreakBand", () => {
  it("returns 0 below all thresholds", () => {
    expect(resolveFailureStreakBand(0)).toBe(0);
    expect(resolveFailureStreakBand(1)).toBe(0);
    expect(resolveFailureStreakBand(2)).toBe(0);
  });

  it("returns 3 for the 3-failure band", () => {
    expect(resolveFailureStreakBand(3)).toBe(3);
    expect(resolveFailureStreakBand(4)).toBe(3);
  });

  it("returns 5 at and above the 5-failure threshold", () => {
    expect(resolveFailureStreakBand(5)).toBe(5);
    expect(resolveFailureStreakBand(6)).toBe(5);
    expect(resolveFailureStreakBand(99)).toBe(5);
  });
});

describe("isFailureGrounded", () => {
  it("returns false below all thresholds (grounding does not apply)", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 2,
        error: "some error",
        groundedErrorMessage: "some error",
        groundedStreakBand: 0,
      }),
    ).toBe(false);
  });

  it("returns false on first entry into threshold band (no prior grounding)", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 3,
        error: "gateway timeout",
        groundedErrorMessage: undefined,
        groundedStreakBand: undefined,
      }),
    ).toBe(false);
  });

  it("returns true (grounded) for repeated identical error in the same band", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 4,
        error: "gateway timeout",
        groundedErrorMessage: "gateway timeout",
        groundedStreakBand: 3,
      }),
    ).toBe(true);
  });

  it("returns false (not grounded) when error message changes", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 4,
        error: "model not found",
        groundedErrorMessage: "gateway timeout",
        groundedStreakBand: 3,
      }),
    ).toBe(false);
  });

  it("returns false when streak escalates to a higher band (3 → 5 transition)", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 5,
        error: "gateway timeout",
        groundedErrorMessage: "gateway timeout",
        groundedStreakBand: 3, // was in band 3, now in band 5
      }),
    ).toBe(false);
  });

  it("returns true after 5-band alert for same error at count 6", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 6,
        error: "rate limit exceeded",
        groundedErrorMessage: "rate limit exceeded",
        groundedStreakBand: 5,
      }),
    ).toBe(true);
  });

  it("trims whitespace when comparing error messages", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 4,
        error: "  gateway timeout  ",
        groundedErrorMessage: "gateway timeout",
        groundedStreakBand: 3,
      }),
    ).toBe(true);
  });

  it("treats undefined error as empty string for comparison", () => {
    expect(
      isFailureGrounded({
        consecutiveErrors: 4,
        error: undefined,
        groundedErrorMessage: "",
        groundedStreakBand: 3,
      }),
    ).toBe(true);

    expect(
      isFailureGrounded({
        consecutiveErrors: 4,
        error: "new error",
        groundedErrorMessage: undefined,
        groundedStreakBand: 3,
      }),
    ).toBe(false);
  });
});

describe("getCronJobFailureDiagnostics", () => {
  const NOW = 1_700_000_000_000;

  it("returns zero-state for a healthy job", () => {
    const diag = getCronJobFailureDiagnostics({}, NOW);
    expect(diag.consecutiveErrors).toBe(0);
    expect(diag.inCooldown).toBe(false);
    expect(diag.cooldownEndsAtMs).toBeUndefined();
    expect(diag.cooldownRemainingMs).toBeUndefined();
    expect(diag.streakBand).toBe(0);
    expect(diag.lastError).toBeUndefined();
  });

  it("reports inCooldown true when failureCooldownEndsAtMs is in the future", () => {
    const cooldownEndsAtMs = NOW + 10 * 60_000;
    const diag = getCronJobFailureDiagnostics(
      { consecutiveErrors: 3, failureCooldownEndsAtMs: cooldownEndsAtMs, lastError: "boom" },
      NOW,
    );
    expect(diag.inCooldown).toBe(true);
    expect(diag.cooldownEndsAtMs).toBe(cooldownEndsAtMs);
    expect(diag.cooldownRemainingMs).toBe(10 * 60_000);
    expect(diag.consecutiveErrors).toBe(3);
    expect(diag.streakBand).toBe(3);
    expect(diag.lastError).toBe("boom");
  });

  it("reports inCooldown false when failureCooldownEndsAtMs is in the past", () => {
    const cooldownEndsAtMs = NOW - 1_000;
    const diag = getCronJobFailureDiagnostics(
      { consecutiveErrors: 3, failureCooldownEndsAtMs: cooldownEndsAtMs },
      NOW,
    );
    expect(diag.inCooldown).toBe(false);
    expect(diag.cooldownEndsAtMs).toBeUndefined();
    expect(diag.cooldownRemainingMs).toBeUndefined();
  });

  it("reports streakBand 5 when consecutiveErrors >= 5", () => {
    const diag = getCronJobFailureDiagnostics({ consecutiveErrors: 7 }, NOW);
    expect(diag.streakBand).toBe(5);
  });
});
