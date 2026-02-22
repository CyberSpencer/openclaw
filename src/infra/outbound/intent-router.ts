import type { ChannelMessageActionName } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

export type MessageUrgency = "low" | "normal" | "high" | "critical";
export type MessagePayloadType = "text" | "media" | "mixed" | "poll" | "unknown";

export type IntentRoutingDecision = {
  channel: DeliverableMessageChannel;
  reason:
    | "explicit-channel"
    | "recipient-hint"
    | "poll-capability"
    | "media-capability"
    | "beeper-first-default"
    | "priority-default";
  policy: "beeper-first-v1";
  explicitChannel: boolean;
  recipient?: string;
  payloadType: MessagePayloadType;
  urgency: MessageUrgency;
  configuredChannels: DeliverableMessageChannel[];
};

export type IntentRouteInput = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  configuredChannels: DeliverableMessageChannel[];
  explicitChannel?: string | null;
  recipient?: string | null;
  payloadType?: MessagePayloadType;
  urgency?: MessageUrgency;
};

const PRIORITY_ORDER: Record<MessageUrgency, string[]> = {
  critical: ["matrix", "signal", "telegram", "whatsapp", "imessage", "slack", "discord"],
  high: ["matrix", "signal", "telegram", "whatsapp", "imessage", "slack", "discord"],
  normal: ["matrix", "telegram", "whatsapp", "signal", "slack", "discord", "imessage"],
  low: ["matrix", "slack", "discord", "telegram", "whatsapp", "signal", "imessage"],
};

const PHONEISH_RE = /^\+?[0-9()\-\s]{7,}$/;

export function normalizeMessageUrgency(value: unknown): MessageUrgency {
  if (typeof value !== "string") {
    return "normal";
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "normal":
    case "high":
    case "critical":
      return normalized;
    default:
      return "normal";
  }
}

export function resolveMessageUrgencyFromParams(params: Record<string, unknown>): MessageUrgency {
  const urgency =
    (typeof params.urgency === "string" ? params.urgency : undefined) ??
    (typeof params.priority === "string" ? params.priority : undefined);
  return normalizeMessageUrgency(urgency);
}

export function inferPayloadTypeForAction(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
}): MessagePayloadType {
  if (params.action === "poll") {
    return "poll";
  }

  const hasMedia =
    (typeof params.args.media === "string" && params.args.media.trim().length > 0) ||
    (typeof params.args.path === "string" && params.args.path.trim().length > 0) ||
    (typeof params.args.filePath === "string" && params.args.filePath.trim().length > 0) ||
    (typeof params.args.buffer === "string" && params.args.buffer.trim().length > 0) ||
    (Array.isArray(params.args.mediaUrls) &&
      params.args.mediaUrls.some((entry) => typeof entry === "string" && entry.trim().length > 0));

  const hasText =
    typeof params.args.message === "string" ||
    typeof params.args.caption === "string" ||
    typeof params.args.quoteText === "string";

  if (hasMedia && hasText) {
    return "mixed";
  }
  if (hasMedia) {
    return "media";
  }
  if (hasText) {
    return "text";
  }
  return "unknown";
}

export function resolveIntentRecipient(args: Record<string, unknown>): string | undefined {
  const candidates = [args.to, args.target, args.channelId, args.userId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function channelRank(channel: string, urgency: MessageUrgency): number {
  const order = PRIORITY_ORDER[urgency];
  const idx = order.indexOf(channel);
  if (idx >= 0) {
    return idx;
  }
  return 100;
}

function orderChannels(
  configuredChannels: DeliverableMessageChannel[],
  urgency: MessageUrgency,
): DeliverableMessageChannel[] {
  return [...configuredChannels].toSorted((a, b) => {
    const rankA = channelRank(a, urgency);
    const rankB = channelRank(b, urgency);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.localeCompare(b);
  });
}

function resolveExplicitChannel(params: {
  explicitChannel?: string | null;
  configuredChannels: DeliverableMessageChannel[];
}): DeliverableMessageChannel | undefined {
  const normalized = normalizeMessageChannel(params.explicitChannel);
  if (!normalized) {
    return undefined;
  }
  if (!params.configuredChannels.includes(normalized as DeliverableMessageChannel)) {
    return undefined;
  }
  return normalized as DeliverableMessageChannel;
}

function resolveRecipientHintChannel(params: {
  recipient?: string | null;
  configuredChannels: DeliverableMessageChannel[];
  urgency: MessageUrgency;
}): DeliverableMessageChannel | undefined {
  const recipient = params.recipient?.trim();
  if (!recipient) {
    return undefined;
  }

  const prefixMatch = /^([a-z0-9_-]+):/i.exec(recipient);
  if (prefixMatch?.[1]) {
    const normalized = normalizeMessageChannel(prefixMatch[1]);
    if (normalized && params.configuredChannels.includes(normalized as DeliverableMessageChannel)) {
      return normalized as DeliverableMessageChannel;
    }
    if (
      (prefixMatch[1].toLowerCase() === "beeper" || prefixMatch[1].toLowerCase() === "matrix") &&
      params.configuredChannels.includes("matrix")
    ) {
      return "matrix";
    }
  }

  const lowered = recipient.toLowerCase();
  if (
    params.configuredChannels.includes("matrix") &&
    (/^[!#$@]/.test(recipient) || lowered.includes(":matrix.") || lowered.startsWith("beeper:"))
  ) {
    return "matrix";
  }

  if (/^@[a-z0-9._-]{2,}$/i.test(recipient) && params.configuredChannels.includes("telegram")) {
    return "telegram";
  }

  if (PHONEISH_RE.test(recipient)) {
    const phoneFirst = orderChannels(
      params.configuredChannels.filter((channel) =>
        ["imessage", "signal", "whatsapp", "telegram"].includes(channel),
      ),
      params.urgency,
    );
    return phoneFirst[0];
  }

  return undefined;
}

function channelSupportsPoll(channel: DeliverableMessageChannel, cfg: OpenClawConfig): boolean {
  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    return false;
  }
  if (plugin.outbound?.sendPoll) {
    return true;
  }
  const listed = plugin.actions?.listActions?.({ cfg }) ?? [];
  if (listed.includes("poll")) {
    return true;
  }
  return Boolean(plugin.actions?.supportsAction?.({ action: "poll" }));
}

function prefersMedia(channel: DeliverableMessageChannel): boolean {
  const plugin = getChannelPlugin(channel);
  return plugin?.capabilities.media === true;
}

export function resolveIntentRoute(input: IntentRouteInput): IntentRoutingDecision {
  if (input.configuredChannels.length === 0) {
    throw new Error("Channel is required (no configured channels detected).");
  }

  const urgency = input.urgency ?? "normal";
  const payloadType = input.payloadType ?? "unknown";
  const explicitChannel = resolveExplicitChannel({
    explicitChannel: input.explicitChannel,
    configuredChannels: input.configuredChannels,
  });

  if (explicitChannel) {
    return {
      channel: explicitChannel,
      reason: "explicit-channel",
      policy: "beeper-first-v1",
      explicitChannel: true,
      recipient: input.recipient ?? undefined,
      payloadType,
      urgency,
      configuredChannels: [...input.configuredChannels],
    };
  }

  const ordered = orderChannels(input.configuredChannels, urgency);
  const hintChannel = resolveRecipientHintChannel({
    recipient: input.recipient,
    configuredChannels: ordered,
    urgency,
  });
  if (hintChannel) {
    return {
      channel: hintChannel,
      reason: "recipient-hint",
      policy: "beeper-first-v1",
      explicitChannel: false,
      recipient: input.recipient ?? undefined,
      payloadType,
      urgency,
      configuredChannels: [...input.configuredChannels],
    };
  }

  if (payloadType === "poll" || input.action === "poll") {
    const pollCapable = ordered.filter((channel) => channelSupportsPoll(channel, input.cfg));
    if (pollCapable.length > 0) {
      return {
        channel: pollCapable[0],
        reason: "poll-capability",
        policy: "beeper-first-v1",
        explicitChannel: false,
        recipient: input.recipient ?? undefined,
        payloadType,
        urgency,
        configuredChannels: [...input.configuredChannels],
      };
    }
  }

  if (payloadType === "media" || payloadType === "mixed") {
    const mediaPreferred = ordered.filter((channel) => prefersMedia(channel));
    if (mediaPreferred.length > 0) {
      return {
        channel: mediaPreferred[0],
        reason: "media-capability",
        policy: "beeper-first-v1",
        explicitChannel: false,
        recipient: input.recipient ?? undefined,
        payloadType,
        urgency,
        configuredChannels: [...input.configuredChannels],
      };
    }
  }

  const reason = ordered[0] === "matrix" ? "beeper-first-default" : "priority-default";
  return {
    channel: ordered[0],
    reason,
    policy: "beeper-first-v1",
    explicitChannel: false,
    recipient: input.recipient ?? undefined,
    payloadType,
    urgency,
    configuredChannels: [...input.configuredChannels],
  };
}
