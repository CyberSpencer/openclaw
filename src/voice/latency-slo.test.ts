import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_LATENCY_BUDGET,
  evaluateVoiceLatencySlo,
  type VoiceLatencySample,
} from "./latency-slo.js";

describe("evaluateVoiceLatencySlo", () => {
  it("passes when p95 metrics are within budget", () => {
    const samples: VoiceLatencySample[] = [
      { totalMs: 4200, firstAudioMs: 1800, transcribeMs: 500, llmMs: 1900, ttsMs: 600 },
      { totalMs: 5100, firstAudioMs: 2300, transcribeMs: 700, llmMs: 2100, ttsMs: 700 },
      { totalMs: 4800, firstAudioMs: 2100, transcribeMs: 600, llmMs: 2000, ttsMs: 650 },
      { totalMs: 5300, firstAudioMs: 2400, transcribeMs: 800, llmMs: 2200, ttsMs: 700 },
      { totalMs: 4700, firstAudioMs: 2050, transcribeMs: 650, llmMs: 1950, ttsMs: 620 },
    ];

    const result = evaluateVoiceLatencySlo(samples, DEFAULT_VOICE_LATENCY_BUDGET);

    expect(result.pass).toBe(true);
    expect(result.breaches).toEqual([]);
  });

  it("fails and reports breaches when budgets are exceeded", () => {
    const samples: VoiceLatencySample[] = [
      { totalMs: 9000, firstAudioMs: 3800, transcribeMs: 2100, llmMs: 5500, ttsMs: 2600 },
      { totalMs: 9800, firstAudioMs: 4200, transcribeMs: 2400, llmMs: 5900, ttsMs: 2800 },
      { totalMs: 9200, firstAudioMs: 3900, transcribeMs: 2000, llmMs: 5600, ttsMs: 2500 },
    ];

    const result = evaluateVoiceLatencySlo(samples, DEFAULT_VOICE_LATENCY_BUDGET);

    expect(result.pass).toBe(false);
    expect(result.breaches.length).toBeGreaterThanOrEqual(3);
    expect(result.breaches.join(" ")).toContain("first-audio p95");
    expect(result.breaches.join(" ")).toContain("llm p95");
    expect(result.breaches.join(" ")).toContain("tts p95");
  });

  it("derives first-audio from stage timings when explicit firstAudioMs is missing", () => {
    const samples: VoiceLatencySample[] = [
      { totalMs: 5000, transcribeMs: 700, routeMs: 200, llmMs: 2200, ttsMs: 600 },
      { totalMs: 5100, transcribeMs: 800, routeMs: 200, llmMs: 2100, ttsMs: 700 },
    ];

    const result = evaluateVoiceLatencySlo(samples, {
      ...DEFAULT_VOICE_LATENCY_BUDGET,
      maxP95FirstAudioMs: 4000,
    });

    expect(result.metrics.p95FirstAudioMs).toBeGreaterThan(0);
    expect(result.pass).toBe(true);
  });

  it("fails closed when no samples are provided", () => {
    const result = evaluateVoiceLatencySlo([], DEFAULT_VOICE_LATENCY_BUDGET);

    expect(result.pass).toBe(false);
    expect(result.metrics).toEqual({
      p95FirstAudioMs: 0,
      p95TotalMs: 0,
      p95TranscribeMs: 0,
      p95LlmMs: 0,
      p95TtsMs: 0,
    });
    expect(result.breaches).toEqual(["no latency samples provided"]);
  });
});
