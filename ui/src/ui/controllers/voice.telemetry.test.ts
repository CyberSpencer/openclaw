import { describe, expect, it } from "vitest";
import { withTurnTelemetry } from "./voice.ts";

describe("withTurnTelemetry", () => {
  it("adds mic and first-speech timings to backend timings", () => {
    const merged = withTurnTelemetry(
      {
        sttMs: 120,
        llmMs: 240,
        ttsMs: 180,
        totalMs: 650,
      },
      {
        micStartMs: 45,
        firstSpeechMs: 310,
        totalMs: 999,
      },
    );

    expect(merged).toMatchObject({
      micStartMs: 45,
      firstSpeechMs: 310,
      captureMs: 45,
      sttMs: 120,
      transcribeMs: 120,
      llmMs: 240,
      ttsMs: 180,
      totalMs: 650,
      stages: expect.objectContaining({
        captureMs: 45,
        transcribeMs: 120,
        llmMs: 240,
        ttsMs: 180,
      }),
    });
  });

  it("builds telemetry when backend timings are absent", () => {
    const merged = withTurnTelemetry(null, {
      micStartMs: 30,
      firstSpeechMs: 200,
      totalMs: 500,
    });

    expect(merged).toEqual({
      micStartMs: 30,
      firstSpeechMs: 200,
      captureMs: 30,
      transcribeMs: undefined,
      routeMs: undefined,
      stages: {
        captureMs: 30,
      },
      totalMs: 500,
    });
  });
});
