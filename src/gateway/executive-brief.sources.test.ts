import { describe, expect, it } from "vitest";
import type { ExecutiveBriefWindows } from "./executive-brief.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { collectCronSource, collectMessagingSource } from "./executive-brief.sources.js";

const windows: ExecutiveBriefWindows = {
  sessionsMinutes: 60,
  usageMinutes: 60,
  orchestratorMinutes: 60,
  cronMinutes: 60,
  messagingMinutes: 60,
};

describe("executive brief source fallbacks", () => {
  it("returns unavailable cron source when cron service fails", async () => {
    const context = {
      cron: {
        status: async () => {
          throw new Error("cron offline");
        },
      },
    } as unknown as GatewayRequestContext;

    const source = await collectCronSource(context, windows);

    expect(source.status).toBe("unavailable");
    expect(source.enabled).toBe(false);
    expect(source.warnings[0]).toContain("cron offline");
  });

  it("returns partial messaging source when no channel accounts are configured", () => {
    const context = {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
    } as unknown as GatewayRequestContext;

    const source = collectMessagingSource(context, windows);

    expect(source.status).toBe("partial");
    expect(source.totalAccounts).toBe(0);
    expect(source.warnings[0]).toContain("no channel accounts configured");
  });
});
