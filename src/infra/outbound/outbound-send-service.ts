import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { retryAsync } from "../retry.js";
import { throwIfAborted } from "./abort.js";
import {
  getDeliveryByIdempotencyKey,
  markDeliveryAcknowledged,
  markDeliveryFailed,
  markDeliveryRetrying,
  markDeliverySent,
  registerDelivery,
} from "./delivery-ledger.js";
import {
  isRetryableDeliveryError,
  resolveDeliveryRetryPolicy,
  resolveRetryAfterMs,
} from "./delivery-retry.js";
import { sendMessage, sendPoll } from "./message.js";

export type OutboundGatewayContext = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type OutboundSendContext = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  abortSignal?: AbortSignal;
};

function extractToolPayload(result: AgentToolResult<unknown>): unknown {
  if (result.details !== undefined) {
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    : undefined;
  const text = (textBlock as { text?: string } | undefined)?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content ?? result;
}

export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  bestEffort?: boolean;
  idempotencyKey?: string;
  urgency?: string;
  routingDecision?: {
    reason?: string;
    explicitChannel?: boolean;
  };
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  const payloadType =
    (params.mediaUrl || (params.mediaUrls?.length ?? 0) > 0) && params.message
      ? "mixed"
      : params.mediaUrl || (params.mediaUrls?.length ?? 0) > 0
        ? "media"
        : "text";
  const urgencyRaw = typeof params.urgency === "string" ? params.urgency.trim().toLowerCase() : "";
  const urgency =
    urgencyRaw === "low" ||
    urgencyRaw === "normal" ||
    urgencyRaw === "high" ||
    urgencyRaw === "critical"
      ? urgencyRaw
      : "normal";

  const idempotencyKey = params.idempotencyKey?.trim();
  if (!params.ctx.dryRun && idempotencyKey) {
    const existing = getDeliveryByIdempotencyKey(idempotencyKey);
    if (
      existing &&
      (existing.state === "sent" || existing.state === "acknowledged") &&
      existing.result?.sendAction
    ) {
      markDeliveryAcknowledged({ id: existing.id, note: "idempotent replay" });
      return {
        handledBy: existing.result.sendAction.handledBy,
        payload: existing.result.sendAction.payload,
        sendResult: existing.result.sendAction.sendResult as MessageSendResult | undefined,
      };
    }
  }

  const ledgerEntry = params.ctx.dryRun
    ? null
    : registerDelivery({
        idempotencyKey,
        action: "send",
        channel: params.ctx.channel,
        to: params.to,
        payloadType,
        urgency,
        explicitChannel: params.routingDecision?.explicitChannel,
        routeReason: params.routingDecision?.reason,
      });

  const runSend = async (): Promise<{
    handledBy: "plugin" | "core";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    sendResult?: MessageSendResult;
  }> => {
    throwIfAborted(params.ctx.abortSignal);
    if (!params.ctx.dryRun) {
      const handled = await dispatchChannelMessageAction({
        channel: params.ctx.channel,
        action: "send",
        cfg: params.ctx.cfg,
        params: params.ctx.params,
        accountId: params.ctx.accountId ?? undefined,
        gateway: params.ctx.gateway,
        toolContext: params.ctx.toolContext,
        dryRun: params.ctx.dryRun,
      });
      if (handled) {
        if (params.ctx.mirror) {
          const mirrorText = params.ctx.mirror.text ?? params.message;
          const mirrorMediaUrls =
            params.ctx.mirror.mediaUrls ??
            params.mediaUrls ??
            (params.mediaUrl ? [params.mediaUrl] : undefined);
          await appendAssistantMessageToSessionTranscript({
            agentId: params.ctx.mirror.agentId,
            sessionKey: params.ctx.mirror.sessionKey,
            text: mirrorText,
            mediaUrls: mirrorMediaUrls,
          });
        }
        return {
          handledBy: "plugin",
          payload: extractToolPayload(handled),
          toolResult: handled,
        };
      }
    }

    throwIfAborted(params.ctx.abortSignal);
    const result: MessageSendResult = await sendMessage({
      cfg: params.ctx.cfg,
      to: params.to,
      content: params.message,
      mediaUrl: params.mediaUrl || undefined,
      mediaUrls: params.mediaUrls,
      channel: params.ctx.channel || undefined,
      accountId: params.ctx.accountId ?? undefined,
      gifPlayback: params.gifPlayback,
      dryRun: params.ctx.dryRun,
      bestEffort: params.bestEffort ?? undefined,
      deps: params.ctx.deps,
      gateway: params.ctx.gateway,
      mirror: params.ctx.mirror,
      abortSignal: params.ctx.abortSignal,
      idempotencyKey: idempotencyKey || undefined,
    });

    return {
      handledBy: "core",
      payload: result,
      sendResult: result,
    };
  };

  try {
    const retryPolicy = resolveDeliveryRetryPolicy(params.ctx.cfg);
    const sendResult =
      !params.ctx.dryRun && retryPolicy.enabled && retryPolicy.attempts > 1
        ? await retryAsync(runSend, {
            ...retryPolicy,
            label: "message-send",
            shouldRetry: (err) => isRetryableDeliveryError(err),
            retryAfterMs: (err) => resolveRetryAfterMs(err),
            onRetry: (info) => {
              if (!ledgerEntry) {
                return;
              }
              markDeliveryRetrying({
                id: ledgerEntry.id,
                error: info.err instanceof Error ? info.err.message : String(info.err),
                delayMs: info.delayMs,
              });
            },
          })
        : await runSend();

    if (ledgerEntry) {
      markDeliverySent({
        id: ledgerEntry.id,
        result: {
          sendAction: {
            handledBy: sendResult.handledBy,
            payload: sendResult.payload,
            sendResult: sendResult.sendResult,
          },
        },
      });
    }

    return sendResult;
  } catch (err) {
    if (ledgerEntry) {
      markDeliveryFailed({
        id: ledgerEntry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationHours?: number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  if (!params.ctx.dryRun) {
    const handled = await dispatchChannelMessageAction({
      channel: params.ctx.channel,
      action: "poll",
      cfg: params.ctx.cfg,
      params: params.ctx.params,
      accountId: params.ctx.accountId ?? undefined,
      gateway: params.ctx.gateway,
      toolContext: params.ctx.toolContext,
      dryRun: params.ctx.dryRun,
    });
    if (handled) {
      return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
      };
    }
  }

  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: params.to,
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationHours: params.durationHours ?? undefined,
    channel: params.ctx.channel,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
