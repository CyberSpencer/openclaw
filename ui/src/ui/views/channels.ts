import { html, nothing } from "lit";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./channels.types.ts";
import { formatAgo } from "../format.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderDiscordCard } from "./channels.discord.ts";
import { renderGoogleChatCard } from "./channels.googlechat.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import { channelEnabled, renderChannelAccountCount } from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

const COPY_LABEL = "Copy JSON";
const COPIED_LABEL = "Copied";
const ERROR_LABEL = "Copy failed";
const RESET_LABEL_AFTER_MS = 1500;
const RESET_ERROR_AFTER_MS = 2000;

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setCopyButtonLabel(button: HTMLButtonElement, label: string) {
  button.title = label;
  button.setAttribute("aria-label", label);
}

function renderCopySnapshotButton(text: string) {
  return html`
    <button
      class="btn btn--sm"
      type="button"
      title=${COPY_LABEL}
      aria-label=${COPY_LABEL}
      @click=${async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();

        const button = event.currentTarget as HTMLButtonElement | null;
        if (!button || button.dataset.copying === "1") {
          return;
        }

        button.dataset.copying = "1";
        button.disabled = true;

        const copied = await copyTextToClipboard(text);
        if (!button.isConnected) {
          return;
        }

        delete button.dataset.copying;
        button.disabled = false;

        if (!copied) {
          setCopyButtonLabel(button, ERROR_LABEL);
          window.setTimeout(() => {
            if (!button.isConnected) {
              return;
            }
            setCopyButtonLabel(button, COPY_LABEL);
          }, RESET_ERROR_AFTER_MS);
          return;
        }

        setCopyButtonLabel(button, COPIED_LABEL);
        window.setTimeout(() => {
          if (!button.isConnected) {
            return;
          }
          setCopyButtonLabel(button, COPY_LABEL);
        }, RESET_LABEL_AFTER_MS);
      }}
    >
      <span aria-hidden="true">${icons.copy}</span>
      Copy
    </button>
  `;
}

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .toSorted((a, b) => {
      if (a.enabled !== b.enabled) {
        return a.enabled ? -1 : 1;
      }
      return a.order - b.order;
    });
  const snapshotText = props.snapshot
    ? JSON.stringify(props.snapshot, null, 2)
    : "No snapshot yet.";

  return html`
    <section class="grid grid-cols-2">
      ${orderedChannels.map((channel) =>
        renderChannel(channel.key, props, {
          whatsapp,
          telegram,
          discord,
          googlechat,
          slack,
          signal,
          imessage,
          nostr,
          channelAccounts: props.snapshot?.channelAccounts ?? null,
        }),
      )}
    </section>

    <section class="card" style="margin-top: 18px;">
      <details>
        <summary class="row" style="justify-content: space-between; cursor: pointer;">
          <div>
            <div class="card-title">Channel health</div>
            <div class="card-sub">Channel status snapshots from the gateway.</div>
          </div>
          <div class="row" style="gap: 10px;">
            <span class="muted">${props.lastSuccessAt ? formatAgo(props.lastSuccessAt) : "n/a"}</span>
            ${renderCopySnapshotButton(snapshotText)}
          </div>
        </summary>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.lastError}
            </div>`
            : nothing
        }
        <pre class="code-block" style="margin-top: 12px;">
${snapshotText}
        </pre>
      </details>
    </section>
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function renderChannel(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCountLabel = renderChannelAccountCount(key, data.channelAccounts);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCountLabel,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCountLabel,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        accountCountLabel,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
        accountCountLabel,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        accountCountLabel,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        accountCountLabel,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        accountCountLabel,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCountLabel,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = resolveChannelLabel(props.snapshot, key);
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);

  return html`
    <div class="card">
      <div class="card-title">${label}</div>
      <div class="card-sub">Channel status and configuration.</div>
      ${accountCountLabel}

      ${
        accounts.length > 0
          ? html`
            <div class="account-card-list">
              ${accounts.map((account) => renderGenericAccount(account))}
            </div>
          `
          : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${configured == null ? "n/a" : configured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${running == null ? "n/a" : running ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Connected</span>
                <span>${connected == null ? "n/a" : connected ? "Yes" : "No"}</span>
              </div>
            </div>
          `
      }

      ${
        lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({ channelId: key, props })}
    </div>
  `;
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) {
    return "Yes";
  }
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) {
    return "Yes";
  }
  if (account.connected === false) {
    return "No";
  }
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "n/a";
}

function renderGenericAccount(account: ChannelAccountSnapshot) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);

  return html`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${account.name || account.accountId}</div>
        <div class="account-card-id">${account.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">Running</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${account.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${connectedStatus}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
        </div>
        ${
          account.lastError
            ? html`
              <div class="account-card-error">
                ${account.lastError}
              </div>
            `
            : nothing
        }
      </div>
    </div>
  `;
}
