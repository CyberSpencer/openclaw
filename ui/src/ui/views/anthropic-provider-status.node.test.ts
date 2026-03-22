import { describe, expect, it } from "vitest";
import {
  formatResetCountdown,
  resolveWindowBarClass,
  resolveNoteIsWarn,
} from "./anthropic-provider-status.ts";

describe("formatResetCountdown", () => {
  it("returns 'resetting soon' when resetAt is in the past", () => {
    expect(formatResetCountdown(1000, 2000)).toBe("resetting soon");
  });

  it("returns 'resetting soon' when resetAt equals now", () => {
    expect(formatResetCountdown(5000, 5000)).toBe("resetting soon");
  });

  it("formats minutes only when less than 1 hour", () => {
    const now = 0;
    const resetAt = 45 * 60_000; // 45 minutes
    expect(formatResetCountdown(resetAt, now)).toBe("resets in 45m");
  });

  it("formats hours (rounded) for multi-hour durations", () => {
    const now = 0;
    const resetAt = (3 * 60 + 15) * 60_000; // 3h 15m -> formatDurationHuman rounds to "3h"
    expect(formatResetCountdown(resetAt, now)).toBe("resets in 3h");
  });

  it("formats 1h when exactly one hour", () => {
    const now = 0;
    const resetAt = 60 * 60_000;
    expect(formatResetCountdown(resetAt, now)).toBe("resets in 1h");
  });

  it("formats seconds for less than a minute remaining", () => {
    const now = 0;
    const resetAt = 30_000; // 30 seconds
    expect(formatResetCountdown(resetAt, now)).toBe("resets in 30s");
  });
});

describe("resolveWindowBarClass", () => {
  it("returns '' for normal usage under 80%", () => {
    expect(resolveWindowBarClass(50)).toBe("");
  });

  it("returns '' at exactly 80%", () => {
    expect(resolveWindowBarClass(80)).toBe("");
  });

  it("returns 'warn' for usage above 80%", () => {
    expect(resolveWindowBarClass(81)).toBe("warn");
  });

  it("returns 'warn' at 95%", () => {
    expect(resolveWindowBarClass(95)).toBe("warn");
  });

  it("returns 'critical' for usage above 95%", () => {
    expect(resolveWindowBarClass(96)).toBe("critical");
  });

  it("returns 'critical' at 100%", () => {
    expect(resolveWindowBarClass(100)).toBe("critical");
  });
});

describe("resolveNoteIsWarn", () => {
  it("returns true when note contains 'paused'", () => {
    expect(resolveNoteIsWarn("Sonnet paused 45m (rate_limit)")).toBe(true);
  });

  it("returns true when note contains 'rate_limit'", () => {
    expect(resolveNoteIsWarn("provider rate_limit exceeded")).toBe(true);
  });

  it("returns true when note contains both 'paused' and 'rate_limit'", () => {
    expect(resolveNoteIsWarn("paused due to rate_limit")).toBe(true);
  });

  it("returns false for a normal quota note", () => {
    expect(resolveNoteIsWarn("5h: 60% used")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(resolveNoteIsWarn("")).toBe(false);
  });

  it("returns false for unrelated warning text", () => {
    expect(resolveNoteIsWarn("slow response times detected")).toBe(false);
  });

  it("returns true for uppercase Paused", () => {
    expect(resolveNoteIsWarn("Sonnet Paused 30m")).toBe(true);
  });

  it("returns true for uppercase RATE_LIMIT", () => {
    expect(resolveNoteIsWarn("RATE_LIMIT hit")).toBe(true);
  });
});
