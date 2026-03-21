import { describe, expect, it } from "vitest";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  formatUsageWindowSummary,
  resolveUsageSummaryMaxWindows,
} from "./provider-usage.format.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const now = Date.UTC(2026, 0, 7, 12, 0, 0);

function makeSnapshot(windows: ProviderUsageSnapshot["windows"]): ProviderUsageSnapshot {
  return {
    provider: "anthropic",
    displayName: "Claude",
    windows,
  };
}

describe("provider-usage.format", () => {
  it("returns null summary for errored or empty snapshots", () => {
    expect(formatUsageWindowSummary({ ...makeSnapshot([]), error: "HTTP 401" })).toBeNull();
    expect(formatUsageWindowSummary(makeSnapshot([]))).toBeNull();
  });

  it("formats reset windows across now/minute/hour/day/date buckets", () => {
    const summary = formatUsageWindowSummary(
      makeSnapshot([
        { label: "Now", usedPercent: 10, resetAt: now - 1 },
        { label: "Minute", usedPercent: 20, resetAt: now + 30 * 60_000 },
        { label: "Hour", usedPercent: 30, resetAt: now + 2 * 60 * 60_000 + 15 * 60_000 },
        { label: "Day", usedPercent: 40, resetAt: now + (2 * 24 + 3) * 60 * 60_000 },
        { label: "Date", usedPercent: 50, resetAt: Date.UTC(2026, 0, 20, 12, 0, 0) },
      ]),
      { now, includeResets: true },
    );

    expect(summary).toContain("Now 90% left ⏱now");
    expect(summary).toContain("Minute 80% left ⏱30m");
    expect(summary).toContain("Hour 70% left ⏱2h 15m");
    expect(summary).toContain("Day 60% left ⏱2d 3h");
    expect(summary).toMatch(/Date 50% left ⏱[A-Z][a-z]{2} \d{1,2}/);
  });

  it("honors max windows and appends notes", () => {
    const summary = formatUsageWindowSummary(
      {
        ...makeSnapshot([
          { label: "A", usedPercent: 10, resetAt: now + 60_000 },
          { label: "B", usedPercent: 20, resetAt: now + 120_000 },
          { label: "C", usedPercent: 30, resetAt: now + 180_000 },
        ]),
        notes: ["Sonnet paused 58m (rate_limit)"],
      },
      { now, maxWindows: 2, includeResets: false },
    );

    expect(summary).toBe("A 90% left · B 80% left · Sonnet paused 58m (rate_limit)");
  });

  it("uses wider Anthropic window caps for status summaries", () => {
    expect(
      resolveUsageSummaryMaxWindows({
        provider: "anthropic",
        displayName: "Claude",
        windows: [
          { label: "5h", usedPercent: 20 },
          { label: "Week", usedPercent: 50 },
          { label: "Sonnet week", usedPercent: 25 },
          { label: "Opus week", usedPercent: 10 },
        ],
      }),
    ).toBe(4);
    expect(
      resolveUsageSummaryMaxWindows({
        provider: "openai-codex",
        displayName: "Codex",
        windows: [
          { label: "5h", usedPercent: 20 },
          { label: "Week", usedPercent: 50 },
          { label: "Extra", usedPercent: 25 },
        ],
      }),
    ).toBe(2);
  });

  it("formats summary line from highest-usage window and provider cap", () => {
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 20 },
            { label: "Week", usedPercent: 70 },
          ],
          notes: ["via claude.ai web session"],
        },
        {
          provider: "zai",
          displayName: "z.ai",
          windows: [{ label: "Day", usedPercent: 10 }],
        },
      ],
    };

    expect(formatUsageSummaryLine(summary, { now, maxProviders: 1 })).toBe(
      "📊 Usage: Claude 30% left (Week, via claude.ai web session)",
    );
  });

  it("formats report output for empty, error, no-data, plan, and notes entries", () => {
    expect(formatUsageReportLines({ updatedAt: now, providers: [] })).toEqual([
      "Usage: no provider usage available.",
    ]);

    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
          plan: "Plus",
        },
        {
          provider: "xiaomi",
          displayName: "Xiaomi",
          windows: [],
          notes: ["provider paused 20m (unavailable)"],
        },
      ],
    };
    expect(formatUsageReportLines(summary)).toEqual([
      "Usage:",
      "  Codex (Plus): Token expired",
      "  Xiaomi: provider paused 20m (unavailable)",
    ]);
  });
});
