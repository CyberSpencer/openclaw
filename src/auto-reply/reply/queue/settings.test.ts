import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveQueueSettings } from "./settings.js";

describe("queue settings", () => {
  it("defaults webchat to steer", () => {
    const res = resolveQueueSettings({
      cfg: {} as unknown as OpenClawConfig,
      channel: "webchat",
    });
    expect(res.mode).toBe("steer");
  });

  it("defaults unknown channels to collect", () => {
    const res = resolveQueueSettings({
      cfg: {} as unknown as OpenClawConfig,
      channel: "somewhere",
    });
    expect(res.mode).toBe("collect");
  });
});
