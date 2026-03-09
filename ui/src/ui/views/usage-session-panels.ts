import { html, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import { formatCost, formatTokens } from "./usage-shared.ts";
import type { UsageColumnId, UsageSessionEntry } from "./usageTypes.ts";

export function renderSessionsCard(
  sessions: UsageSessionEntry[],
  selectedSessions: string[],
  selectedDays: string[],
  isTokenMode: boolean,
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors",
  sessionSortDir: "asc" | "desc",
  recentSessions: string[],
  sessionsTab: "all" | "recent",
  onSelectSession: (key: string, shiftKey: boolean) => void,
  onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void,
  onSessionSortDirChange: (dir: "asc" | "desc") => void,
  onSessionsTabChange: (tab: "all" | "recent") => void,
  visibleColumns: UsageColumnId[],
  totalSessions: number,
  onClearSessions: () => void,
) {
  const showColumn = (id: UsageColumnId) => visibleColumns.includes(id);
  const formatSessionListLabel = (s: UsageSessionEntry): string => {
    const raw = s.label || s.key;
    // Agent session keys often include a token query param; remove it for readability.
    if (raw.startsWith("agent:") && raw.includes("?token=")) {
      return raw.slice(0, raw.indexOf("?token="));
    }
    return raw;
  };
  const copySessionName = async (s: UsageSessionEntry) => {
    const text = formatSessionListLabel(s);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Best effort; clipboard can fail on insecure contexts or denied permission.
    }
  };

  const buildSessionMeta = (s: UsageSessionEntry): string[] => {
    const parts: string[] = [];
    if (showColumn("channel") && s.channel) {
      parts.push(`channel:${s.channel}`);
    }
    if (showColumn("agent") && s.agentId) {
      parts.push(`agent:${s.agentId}`);
    }
    if (showColumn("provider") && (s.modelProvider || s.providerOverride)) {
      parts.push(`provider:${s.modelProvider ?? s.providerOverride}`);
    }
    if (showColumn("model") && s.model) {
      parts.push(`model:${s.model}`);
    }
    if (showColumn("messages") && s.usage?.messageCounts) {
      parts.push(`msgs:${s.usage.messageCounts.total}`);
    }
    if (showColumn("tools") && s.usage?.toolUsage) {
      parts.push(`tools:${s.usage.toolUsage.totalCalls}`);
    }
    if (showColumn("errors") && s.usage?.messageCounts) {
      parts.push(`errors:${s.usage.messageCounts.errors}`);
    }
    if (showColumn("duration") && s.usage?.durationMs) {
      parts.push(`dur:${formatDurationCompact(s.usage.durationMs, { spaced: true }) ?? "—"}`);
    }
    return parts;
  };

  // Helper to get session value (filtered by days if selected)
  const getSessionValue = (s: UsageSessionEntry): number => {
    const usage = s.usage;
    if (!usage) {
      return 0;
    }

    // If days are selected and session has daily breakdown, compute filtered total
    if (selectedDays.length > 0 && usage.dailyBreakdown && usage.dailyBreakdown.length > 0) {
      const filteredDays = usage.dailyBreakdown.filter((d) => selectedDays.includes(d.date));
      return isTokenMode
        ? filteredDays.reduce((sum, d) => sum + d.tokens, 0)
        : filteredDays.reduce((sum, d) => sum + d.cost, 0);
    }

    // Otherwise use total
    return isTokenMode ? (usage.totalTokens ?? 0) : (usage.totalCost ?? 0);
  };

  const sortedSessions = [...sessions].toSorted((a, b) => {
    switch (sessionSort) {
      case "recent":
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      case "messages":
        return (b.usage?.messageCounts?.total ?? 0) - (a.usage?.messageCounts?.total ?? 0);
      case "errors":
        return (b.usage?.messageCounts?.errors ?? 0) - (a.usage?.messageCounts?.errors ?? 0);
      case "cost":
        return getSessionValue(b) - getSessionValue(a);
      case "tokens":
      default:
        return getSessionValue(b) - getSessionValue(a);
    }
  });
  const sortedWithDir = sessionSortDir === "asc" ? sortedSessions.toReversed() : sortedSessions;

  const totalValue = sortedWithDir.reduce((sum, session) => sum + getSessionValue(session), 0);
  const avgValue = sortedWithDir.length ? totalValue / sortedWithDir.length : 0;
  const totalErrors = sortedWithDir.reduce(
    (sum, session) => sum + (session.usage?.messageCounts?.errors ?? 0),
    0,
  );

  const selectedSet = new Set(selectedSessions);
  const selectedEntries = sortedWithDir.filter((s) => selectedSet.has(s.key));
  const selectedCount = selectedEntries.length;
  const sessionMap = new Map(sortedWithDir.map((s) => [s.key, s]));
  const recentEntries = recentSessions
    .map((key) => sessionMap.get(key))
    .filter((entry): entry is UsageSessionEntry => Boolean(entry));

  return html`
    <div class="card sessions-card">
      <div class="sessions-card-header">
        <div class="card-title">Sessions</div>
        <div class="sessions-card-count">
          ${sessions.length} shown${totalSessions !== sessions.length ? ` · ${totalSessions} total` : ""}
        </div>
      </div>
      <div class="sessions-card-meta">
        <div class="sessions-card-stats">
          <span>${isTokenMode ? formatTokens(avgValue) : formatCost(avgValue)} avg</span>
          <span>${totalErrors} errors</span>
        </div>
        <div class="chart-toggle small">
          <button
            class="toggle-btn ${sessionsTab === "all" ? "active" : ""}"
            @click=${() => onSessionsTabChange("all")}
          >
            All
          </button>
          <button
            class="toggle-btn ${sessionsTab === "recent" ? "active" : ""}"
            @click=${() => onSessionsTabChange("recent")}
          >
            Recently viewed
          </button>
        </div>
        <label class="sessions-sort">
          <span>Sort</span>
          <select
            @change=${(e: Event) => onSessionSortChange((e.target as HTMLSelectElement).value as typeof sessionSort)}
          >
            <option value="cost" ?selected=${sessionSort === "cost"}>Cost</option>
            <option value="errors" ?selected=${sessionSort === "errors"}>Errors</option>
            <option value="messages" ?selected=${sessionSort === "messages"}>Messages</option>
            <option value="recent" ?selected=${sessionSort === "recent"}>Recent</option>
            <option value="tokens" ?selected=${sessionSort === "tokens"}>Tokens</option>
          </select>
        </label>
        <button
          class="btn btn-sm sessions-action-btn icon"
          @click=${() => onSessionSortDirChange(sessionSortDir === "desc" ? "asc" : "desc")}
          title=${sessionSortDir === "desc" ? "Descending" : "Ascending"}
        >
          ${sessionSortDir === "desc" ? "↓" : "↑"}
        </button>
        ${
          selectedCount > 0
            ? html`
                <button class="btn btn-sm sessions-action-btn sessions-clear-btn" @click=${onClearSessions}>
                  Clear Selection
                </button>
              `
            : nothing
        }
      </div>
      ${
        sessionsTab === "recent"
          ? recentEntries.length === 0
            ? html`
                <div class="muted" style="padding: 20px; text-align: center">No recent sessions</div>
              `
            : html`
                <div class="session-bars" style="max-height: 220px; margin-top: 6px;">
                  ${recentEntries.map((s) => {
                    const value = getSessionValue(s);
                    const isSelected = selectedSet.has(s.key);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);
                    return html`
                      <div
                        class="session-bar-row ${isSelected ? "selected" : ""}"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                        <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
          : sessions.length === 0
            ? html`
                <div class="muted" style="padding: 20px; text-align: center">No sessions in range</div>
              `
            : html`
                <div class="session-bars">
                  ${sortedWithDir.slice(0, 50).map((s) => {
                    const value = getSessionValue(s);
                    const isSelected = selectedSessions.includes(s.key);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);

                    return html`
                      <div
                        class="session-bar-row ${isSelected ? "selected" : ""}"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                        <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                  ${sessions.length > 50 ? html`<div class="muted" style="padding: 8px; text-align: center; font-size: 11px;">+${sessions.length - 50} more</div>` : nothing}
                </div>
              `
      }
      ${
        selectedCount > 1
          ? html`
              <div style="margin-top: 10px;">
                <div class="sessions-card-count">Selected (${selectedCount})</div>
                <div class="session-bars" style="max-height: 160px; margin-top: 6px;">
                  ${selectedEntries.map((s) => {
                    const value = getSessionValue(s);
                    const displayLabel = formatSessionListLabel(s);
                    const meta = buildSessionMeta(s);
                    return html`
                      <div
                        class="session-bar-row selected"
                        @click=${(e: MouseEvent) => onSelectSession(s.key, e.shiftKey)}
                        title="${s.key}"
                      >
                        <div class="session-bar-label">
                          <div class="session-bar-title">${displayLabel}</div>
                          ${meta.length > 0 ? html`<div class="session-bar-meta">${meta.join(" · ")}</div>` : nothing}
                        </div>
                  <div class="session-bar-track" style="display: none;"></div>
                        <div class="session-bar-actions">
                          <button
                            class="session-copy-btn"
                            title="Copy session name"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void copySessionName(s);
                            }}
                          >
                            Copy
                          </button>
                          <div class="session-bar-value">${isTokenMode ? formatTokens(value) : formatCost(value)}</div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
