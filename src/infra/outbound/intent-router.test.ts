import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  inferPayloadTypeForAction,
  normalizeMessageUrgency,
  resolveIntentRoute,
  resolveMessageUrgencyFromParams,
} from "./intent-router.js";

const baseCfg = {};

function makePlugin(params: {
  id: string;
  media?: boolean;
  supportsPoll?: boolean;
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: `${params.id} test plugin`,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: params.media ?? true,
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    outbound: params.supportsPoll
      ? {
          deliveryMode: "direct",
          sendText: async () => ({ channel: params.id as never, messageId: "m" }),
          sendMedia: async () => ({ channel: params.id as never, messageId: "m" }),
          sendPoll: async () => ({ channel: params.id as never, messageId: "p" }),
        }
      : {
          deliveryMode: "direct",
          sendText: async () => ({ channel: params.id as never, messageId: "m" }),
          sendMedia: async () => ({ channel: params.id as never, messageId: "m" }),
        },
  };
}

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("intent router", () => {
  it("preserves explicit channel override", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "matrix", source: "test", plugin: makePlugin({ id: "matrix" }) },
        { pluginId: "slack", source: "test", plugin: makePlugin({ id: "slack" }) },
      ]),
    );

    const decision = resolveIntentRoute({
      cfg: baseCfg,
      action: "send",
      configuredChannels: ["matrix", "slack"],
      explicitChannel: "slack",
      recipient: "#alerts",
      payloadType: "text",
      urgency: "high",
    });

    expect(decision.channel).toBe("slack");
    expect(decision.reason).toBe("explicit-channel");
  });

  it("routes beeper-style recipients to matrix when configured", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "matrix", source: "test", plugin: makePlugin({ id: "matrix" }) },
        { pluginId: "telegram", source: "test", plugin: makePlugin({ id: "telegram" }) },
      ]),
    );

    const decision = resolveIntentRoute({
      cfg: baseCfg,
      action: "send",
      configuredChannels: ["telegram", "matrix"],
      recipient: "@alice:matrix.org",
      payloadType: "text",
      urgency: "normal",
    });

    expect(decision.channel).toBe("matrix");
    expect(decision.reason).toBe("recipient-hint");
  });

  it("uses poll capability when action is poll", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "matrix", source: "test", plugin: makePlugin({ id: "matrix" }) },
        {
          pluginId: "telegram",
          source: "test",
          plugin: makePlugin({ id: "telegram", supportsPoll: true }),
        },
      ]),
    );

    const decision = resolveIntentRoute({
      cfg: baseCfg,
      action: "poll",
      configuredChannels: ["matrix", "telegram"],
      recipient: "team-room",
      payloadType: "poll",
      urgency: "normal",
    });

    expect(decision.channel).toBe("telegram");
    expect(decision.reason).toBe("poll-capability");
  });

  it("keeps matrix first by default", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "matrix", source: "test", plugin: makePlugin({ id: "matrix" }) },
        { pluginId: "slack", source: "test", plugin: makePlugin({ id: "slack" }) },
      ]),
    );

    const decision = resolveIntentRoute({
      cfg: baseCfg,
      action: "send",
      configuredChannels: ["slack", "matrix"],
      payloadType: "text",
      urgency: "normal",
    });

    expect(decision.channel).toBe("matrix");
    expect(decision.reason).toBe("beeper-first-default");
  });

  it("normalizes urgency + payload helpers", () => {
    expect(normalizeMessageUrgency("CRITICAL")).toBe("critical");
    expect(resolveMessageUrgencyFromParams({ priority: "high" })).toBe("high");
    expect(
      inferPayloadTypeForAction({
        action: "send",
        args: { message: "hello", media: "https://example.com/a.png" },
      }),
    ).toBe("mixed");
  });
});
