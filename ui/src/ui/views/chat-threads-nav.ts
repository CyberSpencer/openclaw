import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";

import type { GatewaySessionRow, SessionsListResult } from "../types";
import { formatAgo, truncateText } from "../format";
import { icons } from "../icons";

export type ChatThreadsNavProps = {
  connected: boolean;
  onboarding: boolean;
  showThinking: boolean;
  focusMode: boolean;
  loading: boolean;
  error: string | null;
  sessions: SessionsListResult | null;
  activeSessionKey: string;
  query: string;
  showSubagents: boolean;
  onNewChat: () => void;
  onSelectChat: (key: string) => void;
  onQueryChange: (next: string) => void;
  onToggleSubagents: () => void;
  onRenameChat: (key: string) => void;
  onDeleteChat: (key: string) => void;
  onRefresh: () => void;
  onToggleThinking: () => void;
  onToggleFocusMode: () => void;
};

function isSubagentSessionKey(key: string): boolean {
  return key.includes(":subagent:");
}

function resolveThreadTitle(row: GatewaySessionRow): string {
  const label = row.label?.trim();
  if (label) return label;
  const preview = resolveThreadPreview(row);
  const derived = row.derivedTitle?.trim();
  if (derived) {
    // For brand new sessions, the derived title is a short sessionId prefix + date (not helpful).
    // Prefer a friendly placeholder until the first message arrives.
    if (!preview && /^[a-f0-9]{8} \\(\\d{4}-\\d{2}-\\d{2}\\)$/i.test(derived)) {
      return "New chat";
    }
    return derived;
  }
  const displayName = row.displayName?.trim();
  if (displayName) return displayName;
  return row.key;
}

function resolveThreadPreview(row: GatewaySessionRow): string {
  const raw = row.lastMessagePreview?.trim() ?? "";
  return raw.replace(/\s+/g, " ").trim();
}

type ThreadGroup = {
  label: string;
  items: GatewaySessionRow[];
};

function groupThreads(threads: GatewaySessionRow[]): ThreadGroup[] {
  const now = Date.now();
  const byLabel: Record<string, GatewaySessionRow[]> = {};

  const labelFor = (updatedAt: number | null): string => {
    if (!updatedAt) return "Older";
    const diffDays = Math.floor((now - updatedAt) / 86_400_000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "Last 7 days";
    if (diffDays < 30) return "Last 30 days";
    return "Older";
  };

  for (const thread of threads) {
    const label = labelFor(thread.updatedAt);
    byLabel[label] = [...(byLabel[label] ?? []), thread];
  }

  const order = ["Today", "Yesterday", "Last 7 days", "Last 30 days", "Older"];
  return order
    .map((label) => {
      const items = byLabel[label];
      if (!items?.length) return null;
      return { label, items } satisfies ThreadGroup;
    })
    .filter((group): group is ThreadGroup => Boolean(group));
}

function renderFocusIcon() {
  return html`
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
}

function renderThreadItem(props: ChatThreadsNavProps, row: GatewaySessionRow) {
  const active = row.key === props.activeSessionKey;
  const title = resolveThreadTitle(row);
  const preview = resolveThreadPreview(row);
  const time = row.updatedAt ? formatAgo(row.updatedAt) : "";
  const subagent = isSubagentSessionKey(row.key);
  const previewText = truncateText(preview, 90).text;
  return html`
    <div
      class="chat-thread-item ${active ? "active" : ""}"
      role="button"
      tabindex="0"
      aria-current=${active ? "true" : "false"}
      @click=${() => props.onSelectChat(row.key)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelectChat(row.key);
        }
      }}
    >
      <div class="chat-thread-item__main">
        <div class="chat-thread-item__title" title=${title}>${title}</div>
        <div class="chat-thread-item__sub">
          ${subagent
            ? html`<span class="chat-thread-item__pill">Sub-agent</span>`
            : nothing}
          ${previewText
            ? html`<span class="chat-thread-item__preview">${previewText}</span>`
            : html`<span class="chat-thread-item__preview chat-thread-item__preview--empty">No messages yet</span>`}
        </div>
      </div>
      <div class="chat-thread-item__meta">
        ${time ? html`<div class="chat-thread-item__time">${time}</div>` : nothing}
        <div class="chat-thread-item__actions">
          <button
            class="btn btn--icon btn--sm chat-thread-item__action"
            type="button"
            title="Rename chat"
            aria-label="Rename chat"
            @click=${(e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              props.onRenameChat(row.key);
            }}
          >
            ${icons.penLine}
          </button>
          <button
            class="btn btn--icon btn--sm danger chat-thread-item__action"
            type="button"
            title="Delete chat"
            aria-label="Delete chat"
            @click=${(e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              props.onDeleteChat(row.key);
            }}
          >
            ${icons.trash ?? icons.x}
          </button>
        </div>
      </div>
    </div>
  `;
}

function listThreads(props: ChatThreadsNavProps) {
  const all = props.sessions?.sessions ?? [];
  const threads = all
    .filter((row) => row.kind === "direct")
    .filter((row) => (props.showSubagents ? true : !isSubagentSessionKey(row.key)))
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const queryActive = props.query.trim().length > 0;
  const groups = queryActive ? [{ label: "Results", items: threads }] : groupThreads(threads);
  return { threads, groups };
}

export function renderChatThreadsNav(props: ChatThreadsNavProps) {
  const { threads, groups } = listThreads(props);
  const showThinkingToggle = props.onboarding ? false : props.showThinking;
  const focusActive = props.onboarding ? true : props.focusMode;

  return html`
    <section class="chat-nav" aria-label="Chats">
      <button
        class="btn primary chat-nav__new"
        type="button"
        ?disabled=${!props.connected}
        @click=${props.onNewChat}
        title=${props.connected ? "Start a new chat thread" : "Connect to the gateway first"}
      >
        ${icons.penLine}
        New chat
      </button>

      <div class="chat-nav__search" role="search">
        <span class="chat-nav__searchIcon" aria-hidden="true">${icons.search}</span>
        <input
          class="chat-nav__searchInput"
          type="search"
          placeholder="Search chats"
          .value=${props.query}
          ?disabled=${!props.connected}
          @input=${(e: Event) => props.onQueryChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="chat-nav__controls" role="toolbar" aria-label="Chat actions">
        <button
          class="btn btn--icon btn--sm chat-nav__control"
          type="button"
          ?disabled=${!props.connected || props.loading}
          @click=${props.onRefresh}
          title="Refresh chats"
          aria-label="Refresh chats"
        >
          <span class=${props.loading ? "chat-nav__spinner" : ""}>${icons.loader}</span>
        </button>
        <button
          class="btn btn--icon btn--sm chat-nav__control ${showThinkingToggle ? "active" : ""}"
          type="button"
          ?disabled=${props.onboarding}
          @click=${props.onToggleThinking}
          title=${props.onboarding ? "Disabled during onboarding" : "Toggle assistant thinking output"}
          aria-pressed=${showThinkingToggle}
        >
          ${icons.brain}
        </button>
        <button
          class="btn btn--icon btn--sm chat-nav__control ${focusActive ? "active" : ""}"
          type="button"
          ?disabled=${props.onboarding}
          @click=${props.onToggleFocusMode}
          title=${props.onboarding ? "Disabled during onboarding" : "Toggle focus mode"}
          aria-pressed=${focusActive}
        >
          ${renderFocusIcon()}
        </button>
        <button
          class="btn btn--sm chat-nav__toggle ${props.showSubagents ? "active" : ""}"
          type="button"
          ?disabled=${!props.connected}
          @click=${props.onToggleSubagents}
          title="Toggle sub-agent sessions in the chat list"
          aria-pressed=${props.showSubagents}
        >
          ${props.showSubagents ? "All" : "Chats"}
        </button>
      </div>

      ${props.error ? html`<div class="callout danger chat-nav__error">${props.error}</div>` : nothing}

      <div class="chat-nav__list" role="list">
        ${
          props.connected && threads.length === 0 && !props.loading
            ? html`<div class="chat-nav__empty muted">No chats yet.</div>`
            : nothing
        }
        ${groups.map(
          (group) => html`
            <div class="chat-nav__group">
              <div class="chat-nav__groupLabel">${group.label}</div>
              <div class="chat-nav__groupList">
                ${repeat(
                  group.items,
                  (row) => row.key,
                  (row) => renderThreadItem(props, row),
                )}
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
