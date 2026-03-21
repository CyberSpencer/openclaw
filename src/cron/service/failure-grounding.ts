/**
 * Failure grounding and cooldown for cron jobs.
 *
 * "Grounding" means repeated identical failures are recorded and counted but
 * do NOT each trigger an error event to the main session.  Only the first
 * occurrence of a new failure type or a threshold transition (3 → 5) fires.
 *
 * "Cooldown" means the job is delayed for a fixed minimum period after
 * reaching N consecutive failures, independent of the exponential backoff
 * applied per-attempt.
 */

/** Cooldown thresholds in ascending order (checked in reverse). */
export const FAILURE_COOLDOWN_THRESHOLDS: ReadonlyArray<{
  readonly after: number;
  readonly cooldownMs: number;
}> = [
  { after: 3, cooldownMs: 15 * 60_000 }, // 3 consecutive failures → 15 min
  { after: 5, cooldownMs: 60 * 60_000 }, // 5 consecutive failures → 60 min
] as const;

/**
 * Returns the minimum cooldown duration (ms) that applies for the given
 * consecutive error count, or 0 if below all thresholds.
 *
 * Thresholds are evaluated from highest to lowest so the most severe
 * cooldown is returned when multiple thresholds are crossed.
 */
export function resolveFailureCooldownMs(consecutiveErrors: number): number {
  const sorted = FAILURE_COOLDOWN_THRESHOLDS.slice().toSorted((a, b) => b.after - a.after);
  for (const threshold of sorted) {
    if (consecutiveErrors >= threshold.after) {
      return threshold.cooldownMs;
    }
  }
  return 0;
}

/**
 * Returns the "streak band" — the highest threshold that has been reached.
 * 0 = below all thresholds, 3 = in the 3-failure band, 5 = in the 5-failure band.
 *
 * Used to detect band transitions that should re-trigger alert delivery
 * even when the error message has not changed.
 */
export function resolveFailureStreakBand(consecutiveErrors: number): number {
  const sorted = FAILURE_COOLDOWN_THRESHOLDS.slice().toSorted((a, b) => b.after - a.after);
  for (const threshold of sorted) {
    if (consecutiveErrors >= threshold.after) {
      return threshold.after;
    }
  }
  return 0;
}

/**
 * Returns `true` when the failure alert should be SUPPRESSED (grounded).
 *
 * A failure is grounded when:
 * 1. The job is already within a threshold band (streak band ≥ 3).
 * 2. The error message has NOT changed from the last alert.
 * 3. The streak band has NOT escalated to a higher band (e.g., 3 → 5).
 *
 * Grounded failures are still counted and logged; they just don't each
 * push a new system event to the main session.
 */
export function isFailureGrounded(params: {
  consecutiveErrors: number;
  error: string | undefined;
  groundedErrorMessage?: string;
  groundedStreakBand?: number;
}): boolean {
  const currentBand = resolveFailureStreakBand(params.consecutiveErrors);
  if (currentBand === 0) {
    // Below all thresholds — grounding logic does not apply here
    return false;
  }

  const lastBand = params.groundedStreakBand ?? 0;
  if (currentBand > lastBand) {
    // Streak escalated to a higher band — must re-alert
    return false;
  }

  // Same band: suppress if error message matches the last alert
  const normalize = (e: string | undefined) => (e ?? "").trim();
  return normalize(params.error) === normalize(params.groundedErrorMessage);
}

export type CronJobFailureDiagnostics = {
  /** Number of consecutive execution errors (reset on success). */
  consecutiveErrors: number;
  /** Whether the job is currently in a failure cooldown period. */
  inCooldown: boolean;
  /** Epoch ms when the failure cooldown expires (undefined when not in cooldown). */
  cooldownEndsAtMs: number | undefined;
  /** Remaining cooldown duration in ms (undefined when not in cooldown). */
  cooldownRemainingMs: number | undefined;
  /** Highest failure threshold band reached (0, 3, or 5). */
  streakBand: number;
  /** The error message from the most recent failed execution. */
  lastError: string | undefined;
};

/**
 * Returns operator-facing diagnostics for a cron job's failure state.
 * Callers should pass `Date.now()` (or the service's `nowMs()`) as `nowMs`.
 */
export function getCronJobFailureDiagnostics(
  jobState: {
    consecutiveErrors?: number;
    failureCooldownEndsAtMs?: number;
    lastError?: string;
  },
  nowMs: number,
): CronJobFailureDiagnostics {
  const consecutiveErrors = jobState.consecutiveErrors ?? 0;
  const cooldownEndsAtMs = jobState.failureCooldownEndsAtMs;
  const inCooldown =
    typeof cooldownEndsAtMs === "number" &&
    Number.isFinite(cooldownEndsAtMs) &&
    cooldownEndsAtMs > nowMs;
  const cooldownRemainingMs =
    inCooldown && typeof cooldownEndsAtMs === "number"
      ? Math.max(0, cooldownEndsAtMs - nowMs)
      : undefined;

  return {
    consecutiveErrors,
    inCooldown,
    cooldownEndsAtMs: inCooldown ? cooldownEndsAtMs : undefined,
    cooldownRemainingMs,
    streakBand: resolveFailureStreakBand(consecutiveErrors),
    lastError: jobState.lastError,
  };
}
