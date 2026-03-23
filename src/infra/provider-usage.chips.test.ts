import { describe, expect, it } from "vitest";
import { buildProviderUsageChipNotes } from "./provider-usage.chips.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

describe("buildProviderUsageChipNotes", () => {
  it("maps windows to chip strings with reset suffix", () => {
    const now = new Date("2026-01-01T12:00:00Z").getTime();
    const snapshot: ProviderUsageSnapshot = {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "5h", usedPercent: 40, resetAt: now + 30 * 60_000 }],
    };
    const notes = buildProviderUsageChipNotes(snapshot, { now });
    expect(notes).toEqual(["5h: 60% left ⏱30m"]);
  });

  it("includes non-ignored errors", () => {
    const snapshot: ProviderUsageSnapshot = {
      provider: "openai-codex",
      displayName: "Codex",
      windows: [],
      error: "HTTP 503",
    };
    expect(buildProviderUsageChipNotes(snapshot)).toEqual(["HTTP 503"]);
  });
});
