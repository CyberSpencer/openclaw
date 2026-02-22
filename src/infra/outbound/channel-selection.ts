import type { ChannelMessageActionName, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  listDeliverableMessageChannels,
  type DeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  inferPayloadTypeForAction,
  resolveIntentRoute,
  resolveMessageUrgencyFromParams,
  resolveIntentRecipient,
  type IntentRoutingDecision,
} from "./intent-router.js";

export type MessageChannelId = DeliverableMessageChannel;

const getMessageChannels = () => listDeliverableMessageChannels();

function isKnownChannel(value: string): boolean {
  return getMessageChannels().includes(value as MessageChannelId);
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

async function isPluginConfigured(plugin: ChannelPlugin, cfg: OpenClawConfig): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) {
    return false;
  }

  for (const accountId of accountIds) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      continue;
    }
    if (!plugin.config.isConfigured) {
      return true;
    }
    const configured = await plugin.config.isConfigured(account, cfg);
    if (configured) {
      return true;
    }
  }

  return false;
}

export async function listConfiguredMessageChannels(
  cfg: OpenClawConfig,
): Promise<MessageChannelId[]> {
  const channels: MessageChannelId[] = [];
  for (const plugin of listChannelPlugins()) {
    if (!isKnownChannel(plugin.id)) {
      continue;
    }
    if (await isPluginConfigured(plugin, cfg)) {
      channels.push(plugin.id);
    }
  }
  return channels;
}

export type MessageChannelSelectionIntent = {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
};

export async function resolveMessageChannelSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  intent?: MessageChannelSelectionIntent;
}): Promise<{
  channel: MessageChannelId;
  configured: MessageChannelId[];
  decision?: IntentRoutingDecision;
}> {
  const configured = await listConfiguredMessageChannels(params.cfg);
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    if (!isKnownChannel(normalized)) {
      throw new Error(`Unknown channel: ${String(normalized)}`);
    }
    return {
      channel: normalized as MessageChannelId,
      configured,
      decision: {
        channel: normalized as MessageChannelId,
        reason: "explicit-channel",
        policy: "beeper-first-v1",
        explicitChannel: true,
        recipient: params.intent ? resolveIntentRecipient(params.intent.params) : undefined,
        payloadType: params.intent
          ? inferPayloadTypeForAction({ action: params.intent.action, args: params.intent.params })
          : "unknown",
        urgency: params.intent ? resolveMessageUrgencyFromParams(params.intent.params) : "normal",
        configuredChannels: configured,
      },
    };
  }

  if (configured.length === 1) {
    return {
      channel: configured[0],
      configured,
      decision: {
        channel: configured[0],
        reason: configured[0] === "matrix" ? "beeper-first-default" : "priority-default",
        policy: "beeper-first-v1",
        explicitChannel: false,
        recipient: params.intent ? resolveIntentRecipient(params.intent.params) : undefined,
        payloadType: params.intent
          ? inferPayloadTypeForAction({ action: params.intent.action, args: params.intent.params })
          : "unknown",
        urgency: params.intent ? resolveMessageUrgencyFromParams(params.intent.params) : "normal",
        configuredChannels: configured,
      },
    };
  }
  if (configured.length === 0) {
    throw new Error("Channel is required (no configured channels detected).");
  }

  const routerEnabled = params.cfg.tools?.message?.intentRouter?.enabled !== false;
  if (
    routerEnabled &&
    params.intent &&
    (params.intent.action === "send" || params.intent.action === "poll")
  ) {
    const decision = resolveIntentRoute({
      cfg: params.cfg,
      action: params.intent.action,
      configuredChannels: configured,
      explicitChannel: params.channel,
      recipient: resolveIntentRecipient(params.intent.params),
      payloadType: inferPayloadTypeForAction({
        action: params.intent.action,
        args: params.intent.params,
      }),
      urgency: resolveMessageUrgencyFromParams(params.intent.params),
    });
    return {
      channel: decision.channel,
      configured,
      decision,
    };
  }

  throw new Error(
    `Channel is required when multiple channels are configured: ${configured.join(", ")}`,
  );
}
