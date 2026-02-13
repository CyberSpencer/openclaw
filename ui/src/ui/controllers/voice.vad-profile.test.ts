import { describe, expect, it } from "vitest";
import { deriveVadProfile } from "./voice.ts";

describe("deriveVadProfile", () => {
  it("keeps sane minimum thresholds for quiet rooms", () => {
    const profile = deriveVadProfile(3);
    expect(profile.speechThreshold).toBeGreaterThanOrEqual(25);
    expect(profile.silenceThreshold).toBeGreaterThanOrEqual(15);
    expect(profile.silenceDurationMs).toBeGreaterThanOrEqual(550);
  });

  it("raises thresholds and silence timeout for noisy rooms", () => {
    const quiet = deriveVadProfile(5);
    const noisy = deriveVadProfile(35);

    expect(noisy.speechThreshold).toBeGreaterThan(quiet.speechThreshold);
    expect(noisy.silenceThreshold).toBeGreaterThan(quiet.silenceThreshold);
    expect(noisy.silenceDurationMs).toBeGreaterThan(quiet.silenceDurationMs);
  });
});
