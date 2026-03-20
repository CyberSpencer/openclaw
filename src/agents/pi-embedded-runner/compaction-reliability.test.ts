import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCompactionReliabilityState,
  isCompactionBreakerOpen,
  noteCompactionFailure,
  noteCompactionRecovery,
  resetCompactionReliabilityStateForTest,
  resolveAdaptiveToolResultContextShare,
} from "./compaction-reliability.js";

const reliabilityConfig = {
  agents: {
    defaults: {
      compaction: {
        reliability: {
          breakerEnabled: true,
          breakerWindowMs: 60_000,
          maxFailuresBeforeCooldown: 2,
          cooldownMs: 30_000,
          adaptiveFloorMultiplier: 0.5,
          adaptiveCeilingMultiplier: 1,
          adaptiveTightenStep: 0.2,
          adaptiveRelaxStep: 0.1,
          adaptiveRecoveryHysteresis: 2,
        },
      },
    },
  },
} as const;

describe("compaction reliability policy", () => {
  beforeEach(() => {
    resetCompactionReliabilityStateForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCompactionReliabilityStateForTest();
  });

  it("opens cooldown after repeated failures inside the breaker window", () => {
    const state = getCompactionReliabilityState("session-1", reliabilityConfig);

    noteCompactionFailure(state, "explicit_failed", reliabilityConfig);
    expect(isCompactionBreakerOpen(state, reliabilityConfig)).toBe(false);

    noteCompactionFailure(state, "explicit_failed", reliabilityConfig);
    expect(isCompactionBreakerOpen(state, reliabilityConfig)).toBe(true);

    vi.advanceTimersByTime(30_001);
    expect(isCompactionBreakerOpen(state, reliabilityConfig)).toBe(false);
  });

  it("clears breaker pressure after a successful recovery", () => {
    const state = getCompactionReliabilityState("session-2", reliabilityConfig);

    noteCompactionFailure(state, "explicit_failed", reliabilityConfig);
    noteCompactionFailure(state, "explicit_failed", reliabilityConfig);
    expect(isCompactionBreakerOpen(state, reliabilityConfig)).toBe(true);

    noteCompactionRecovery(state, "explicit_compacted", reliabilityConfig);
    expect(isCompactionBreakerOpen(state, reliabilityConfig)).toBe(false);
  });

  it("tightens adaptive truncation after failures and relaxes only after hysteresis", () => {
    const state = getCompactionReliabilityState("session-3", reliabilityConfig);

    expect(resolveAdaptiveToolResultContextShare(state)).toBeCloseTo(0.3, 5);

    noteCompactionFailure(state, "explicit_failed", reliabilityConfig);
    expect(resolveAdaptiveToolResultContextShare(state)).toBeCloseTo(0.24, 5);

    noteCompactionFailure(state, "no_op", reliabilityConfig);
    expect(resolveAdaptiveToolResultContextShare(state)).toBeCloseTo(0.18, 5);

    noteCompactionRecovery(state, "truncated", reliabilityConfig);
    expect(resolveAdaptiveToolResultContextShare(state)).toBeCloseTo(0.18, 5);

    noteCompactionRecovery(state, "explicit_compacted", reliabilityConfig);
    expect(resolveAdaptiveToolResultContextShare(state)).toBeCloseTo(0.21, 5);
  });
});
