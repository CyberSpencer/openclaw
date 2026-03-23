import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      daily: [],
      totals: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
    })),
  };
});

vi.mock("../../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: vi.fn(async () => ({
    updatedAt: Date.now(),
    providers: [],
  })),
}));

import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { loadCostUsageSummary } from "../../infra/session-cost-usage.js";
import { __test, usageHandlers } from "./usage.js";

function resetProviderUsageCache() {
  const cache = __test.providerUsageCache as Record<string, unknown>;
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}

describe("gateway usage helpers", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    __test.costUsageCache.clear();
    resetProviderUsageCache();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parseDateToMs accepts YYYY-MM-DD and rejects invalid input", () => {
    expect(__test.parseDateToMs("2026-02-05")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs(" 2026-02-05 ")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs("2026-2-5")).toBeUndefined();
    expect(__test.parseDateToMs("nope")).toBeUndefined();
    expect(__test.parseDateToMs(undefined)).toBeUndefined();
  });

  it("parseUtcOffsetToMinutes supports whole-hour and half-hour offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC-4")).toBe(-240);
    expect(__test.parseUtcOffsetToMinutes("UTC+5:30")).toBe(330);
    expect(__test.parseUtcOffsetToMinutes(" UTC+14 ")).toBe(14 * 60);
  });

  it("parseUtcOffsetToMinutes rejects invalid offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC+14:30")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+5:99")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+25")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("GMT+5")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes(undefined)).toBeUndefined();
  });

  it("parseDays coerces strings/numbers to integers", () => {
    expect(__test.parseDays(7.9)).toBe(7);
    expect(__test.parseDays("30")).toBe(30);
    expect(__test.parseDays("")).toBeUndefined();
    expect(__test.parseDays("nope")).toBeUndefined();
  });

  it("parseDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const range = __test.parseDateRange({ startDate: "2026-02-01", endDate: "2026-02-02" });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses explicit UTC mode", () => {
    const range = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "utc",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific UTC offset for explicit dates", () => {
    const range = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "UTC+5:30",
    });
    const start = Date.UTC(2026, 1, 1) - 5.5 * 60 * 60 * 1000;
    const endStart = Date.UTC(2026, 1, 2) - 5.5 * 60 * 60 * 1000;
    expect(range.startMs).toBe(start);
    expect(range.endMs).toBe(endStart + dayMs - 1);
  });

  it("parseDateRange falls back to UTC when specific mode offset is missing or invalid", () => {
    const missingOffset = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
    });
    const invalidOffset = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "bad-value",
    });
    expect(missingOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(missingOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
    expect(invalidOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(invalidOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific offset for today/day math after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
    const range = __test.parseDateRange({
      days: 1,
      mode: "specific",
      utcOffset: "UTC-5",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 16, 5, 0, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 17, 4, 59, 59, 999));
  });

  it("parseDateRange uses gateway local day boundaries in gateway mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const range = __test.parseDateRange({ days: 1, mode: "gateway" });
    const expectedStart = new Date(2026, 1, 5).getTime();
    expect(range.startMs).toBe(expectedStart);
    expect(range.endMs).toBe(expectedStart + dayMs - 1);
  });

  it("parseDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = __test.parseDateRange({ days: 0 });
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const def = __test.parseDateRange({});
    expect(def.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(def.startMs).toBe(Date.UTC(2026, 1, 5) - 29 * dayMs);
  });

  it("loadCostUsageSummaryCached caches within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const config = {} as OpenClawConfig;
    const a = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    const b = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });

    expect(a.totals.totalTokens).toBe(1);
    expect(b.totals.totalTokens).toBe(1);
    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(1);
  });

  it("loadProviderUsageSummaryCached caches successful snapshots within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));
    vi.mocked(loadProviderUsageSummary).mockResolvedValue({
      updatedAt: Date.now(),
      providers: [{ provider: "anthropic", displayName: "Anthropic", windows: [] }],
    });

    const a = await __test.loadProviderUsageSummaryCached();
    const b = await __test.loadProviderUsageSummaryCached();

    expect(a.providers).toHaveLength(1);
    expect(b.providers).toHaveLength(1);
    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent cold-start provider usage refreshes", async () => {
    let resolveSummary: ((value: { updatedAt: number; providers: [] }) => void) | null = null;
    vi.mocked(loadProviderUsageSummary).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
    );

    const first = __test.loadProviderUsageSummaryCached();
    const second = __test.loadProviderUsageSummaryCached();

    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(1);

    resolveSummary?.({ updatedAt: Date.now(), providers: [] });

    await expect(first).resolves.toEqual({ updatedAt: expect.any(Number), providers: [] });
    await expect(second).resolves.toEqual({ updatedAt: expect.any(Number), providers: [] });
  });

  it("serves the last good provider snapshot while a stale refresh fails with HTTP 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const goodSummary = {
      updatedAt: Date.now(),
      providers: [{ provider: "anthropic", displayName: "Anthropic", windows: [] }],
    };
    vi.mocked(loadProviderUsageSummary)
      .mockResolvedValueOnce(goodSummary)
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { status: 429 }));

    expect(await __test.loadProviderUsageSummaryCached()).toEqual(goodSummary);
    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);

    await expect(__test.loadProviderUsageSummaryCached()).resolves.toEqual(goodSummary);
    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(2);

    await Promise.resolve();
    await Promise.resolve();

    await expect(__test.loadProviderUsageSummaryCached()).resolves.toEqual(goodSummary);
    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(2);
  });

  it("returns an empty fallback summary during cold-start provider usage backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));
    vi.mocked(loadProviderUsageSummary).mockRejectedValue(
      Object.assign(new Error("HTTP 429"), { status: 429 }),
    );

    const first = await __test.loadProviderUsageSummaryCached();
    const second = await __test.loadProviderUsageSummaryCached();

    expect(first.providers).toEqual([]);
    expect(second.providers).toEqual([]);
    expect(vi.mocked(loadProviderUsageSummary)).toHaveBeenCalledTimes(1);
  });

  it("usage.status responds with cached provider usage instead of surfacing transient refresh failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const respond = vi.fn();
    const goodSummary = {
      updatedAt: Date.now(),
      providers: [{ provider: "anthropic", displayName: "Anthropic", windows: [] }],
    };
    vi.mocked(loadProviderUsageSummary)
      .mockResolvedValueOnce(goodSummary)
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { status: 429 }));

    await usageHandlers["usage.status"]({
      respond,
    } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);

    vi.advanceTimersByTime(5 * 60_000 + 1);

    await usageHandlers["usage.status"]({
      respond,
    } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);

    expect(respond).toHaveBeenNthCalledWith(1, true, goodSummary, undefined);
    expect(respond).toHaveBeenNthCalledWith(2, true, goodSummary, undefined);
  });
});
