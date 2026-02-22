export type VoiceLatencySample = {
  totalMs: number;
  firstAudioMs?: number;
  transcribeMs?: number;
  routeMs?: number;
  llmMs?: number;
  ttsMs?: number;
};

export type VoiceLatencySloBudget = {
  maxP95FirstAudioMs: number;
  maxP95TotalMs: number;
  maxP95TranscribeMs: number;
  maxP95LlmMs: number;
  maxP95TtsMs: number;
};

export type VoiceLatencySloMetrics = {
  p95FirstAudioMs: number;
  p95TotalMs: number;
  p95TranscribeMs: number;
  p95LlmMs: number;
  p95TtsMs: number;
};

export type VoiceLatencySloResult = {
  pass: boolean;
  metrics: VoiceLatencySloMetrics;
  breaches: string[];
};

export const DEFAULT_VOICE_LATENCY_BUDGET: VoiceLatencySloBudget = {
  maxP95FirstAudioMs: 3500,
  maxP95TotalMs: 9000,
  maxP95TranscribeMs: 1800,
  maxP95LlmMs: 5000,
  maxP95TtsMs: 2200,
};

function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index];
}

function positiveNumbers(values: Array<number | undefined>): number[] {
  return values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)));
}

function deriveFirstAudioMs(sample: VoiceLatencySample): number {
  if (typeof sample.firstAudioMs === "number" && Number.isFinite(sample.firstAudioMs)) {
    return Math.max(0, Math.round(sample.firstAudioMs));
  }
  return Math.max(
    0,
    Math.round(
      (sample.transcribeMs ?? 0) +
        (sample.routeMs ?? 0) +
        (sample.llmMs ?? 0) +
        (sample.ttsMs ?? 0),
    ),
  );
}

export function evaluateVoiceLatencySlo(
  samples: VoiceLatencySample[],
  budget: VoiceLatencySloBudget = DEFAULT_VOICE_LATENCY_BUDGET,
): VoiceLatencySloResult {
  const firstAudioValues = positiveNumbers(samples.map((sample) => deriveFirstAudioMs(sample)));
  const totalValues = positiveNumbers(samples.map((sample) => sample.totalMs));
  const transcribeValues = positiveNumbers(samples.map((sample) => sample.transcribeMs));
  const llmValues = positiveNumbers(samples.map((sample) => sample.llmMs));
  const ttsValues = positiveNumbers(samples.map((sample) => sample.ttsMs));

  const metrics: VoiceLatencySloMetrics = {
    p95FirstAudioMs: percentile(firstAudioValues, 0.95),
    p95TotalMs: percentile(totalValues, 0.95),
    p95TranscribeMs: percentile(transcribeValues, 0.95),
    p95LlmMs: percentile(llmValues, 0.95),
    p95TtsMs: percentile(ttsValues, 0.95),
  };

  const breaches: string[] = [];
  if (metrics.p95FirstAudioMs > budget.maxP95FirstAudioMs) {
    breaches.push(
      `first-audio p95 ${metrics.p95FirstAudioMs}ms > budget ${budget.maxP95FirstAudioMs}ms`,
    );
  }
  if (metrics.p95TotalMs > budget.maxP95TotalMs) {
    breaches.push(`total-turn p95 ${metrics.p95TotalMs}ms > budget ${budget.maxP95TotalMs}ms`);
  }
  if (metrics.p95TranscribeMs > budget.maxP95TranscribeMs) {
    breaches.push(
      `transcribe p95 ${metrics.p95TranscribeMs}ms > budget ${budget.maxP95TranscribeMs}ms`,
    );
  }
  if (metrics.p95LlmMs > budget.maxP95LlmMs) {
    breaches.push(`llm p95 ${metrics.p95LlmMs}ms > budget ${budget.maxP95LlmMs}ms`);
  }
  if (metrics.p95TtsMs > budget.maxP95TtsMs) {
    breaches.push(`tts p95 ${metrics.p95TtsMs}ms > budget ${budget.maxP95TtsMs}ms`);
  }

  return {
    pass: breaches.length === 0,
    metrics,
    breaches,
  };
}
