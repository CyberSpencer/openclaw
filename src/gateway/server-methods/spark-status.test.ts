import { describe, expect, it } from "vitest";
import { mapDgxStatsPayload } from "./spark-status.js";

describe("mapDgxStatsPayload", () => {
  it("maps dgx-stats services and voice availability", () => {
    const checkedAt = 1_700_000_000_000;
    const out = mapDgxStatsPayload(
      {
        overall: "healthy",
        counts: { healthy: 7, degraded: 0, down: 0, total: 7 },
        services: {
          ollama: { status: "healthy", code: 200, latency_ms: 5 },
          voice_stt: { status: "healthy", code: 200, latency_ms: 8 },
          voice_tts: { status: "healthy", code: 200, latency_ms: 9 },
        },
        voice: { available: true },
      },
      "192.168.1.93",
      checkedAt,
    );
    expect(out.source).toBe("dgx-stats");
    expect(out.host).toBe("192.168.1.93");
    expect(out.voiceAvailable).toBe(true);
    expect(out.active).toBe(true);
    const ollama = (out.services as Record<string, { healthy?: boolean }>).ollama;
    expect(ollama?.healthy).toBe(true);
  });

  it("marks active false when overall is down", () => {
    const out = mapDgxStatsPayload({ overall: "down", services: {} }, null, 0);
    expect(out.active).toBe(false);
  });
});
