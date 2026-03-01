import { html, nothing } from "lit";
import type {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageSessionEntry,
} from "./usageTypes.ts";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import {
  renderContextPanel,
  renderSessionLogsCompact,
  renderTimeSeriesCompact,
} from "./usage-session-sections.ts";
import { formatCost, formatTokens } from "./usage-shared.ts";

function renderInsightList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string }>,
  emptyLabel: string,
) {
  return html`
    <div class="usage-insight-card">
      <div class="usage-insight-title">${title}</div>
      ${
        items.length === 0
          ? html`<div class="muted">${emptyLabel}</div>`
          : html`
              <div class="usage-list">
                ${items.map(
                  (item) => html`
                    <div class="usage-list-item">
                      <span>${item.label}</span>
                      <span class="usage-list-value">
                        <span>${item.value}</span>
                        ${item.sub ? html`<span class="usage-list-sub">${item.sub}</span>` : nothing}
                      </span>
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

export function renderEmptyDetailState() {
  return nothing;
}

function renderSessionSummary(session: UsageSessionEntry) {
  const usage = session.usage;
  if (!usage) {
    return html`
      <div class="muted">No usage data for this session.</div>
    `;
  }

  const formatTs = (ts?: number): string => (ts ? new Date(ts).toLocaleString() : "—");

  const badges: string[] = [];
  if (session.channel) {
    badges.push(`channel:${session.channel}`);
  }
  if (session.agentId) {
    badges.push(`agent:${session.agentId}`);
  }
  if (session.modelProvider || session.providerOverride) {
    badges.push(`provider:${session.modelProvider ?? session.providerOverride}`);
  }
  if (session.model) {
    badges.push(`model:${session.model}`);
  }

  const toolItems =
    usage.toolUsage?.tools.slice(0, 6).map((tool) => ({
      label: tool.name,
      value: `${tool.count}`,
      sub: "calls",
    })) ?? [];
  const modelItems =
    usage.modelUsage?.slice(0, 6).map((entry) => ({
      label: entry.model ?? "unknown",
      value: formatCost(entry.totals.totalCost),
      sub: formatTokens(entry.totals.totalTokens),
    })) ?? [];

  return html`
    ${badges.length > 0 ? html`<div class="usage-badges">${badges.map((b) => html`<span class="usage-badge">${b}</span>`)}</div>` : nothing}
    <div class="session-summary-grid">
      <div class="session-summary-card">
        <div class="session-summary-title">Messages</div>
        <div class="session-summary-value">${usage.messageCounts?.total ?? 0}</div>
        <div class="session-summary-meta">${usage.messageCounts?.user ?? 0} user · ${usage.messageCounts?.assistant ?? 0} assistant</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Tool Calls</div>
        <div class="session-summary-value">${usage.toolUsage?.totalCalls ?? 0}</div>
        <div class="session-summary-meta">${usage.toolUsage?.uniqueTools ?? 0} tools</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Errors</div>
        <div class="session-summary-value">${usage.messageCounts?.errors ?? 0}</div>
        <div class="session-summary-meta">${usage.messageCounts?.toolResults ?? 0} tool results</div>
      </div>
      <div class="session-summary-card">
        <div class="session-summary-title">Duration</div>
        <div class="session-summary-value">${formatDurationCompact(usage.durationMs, { spaced: true }) ?? "—"}</div>
        <div class="session-summary-meta">${formatTs(usage.firstActivity)} → ${formatTs(usage.lastActivity)}</div>
      </div>
    </div>
    <div class="usage-insights-grid" style="margin-top: 12px;">
      ${renderInsightList("Top Tools", toolItems, "No tool calls")}
      ${renderInsightList("Model Mix", modelItems, "No model data")}
    </div>
  `;
}

export function renderSessionDetailPanel(
  session: UsageSessionEntry,
  timeSeries: { points: TimeSeriesPoint[] } | null,
  timeSeriesLoading: boolean,
  timeSeriesMode: "cumulative" | "per-turn",
  onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void,
  timeSeriesBreakdownMode: "total" | "by-type",
  onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void,
  startDate: string,
  endDate: string,
  selectedDays: string[],
  sessionLogs: SessionLogEntry[] | null,
  sessionLogsLoading: boolean,
  sessionLogsExpanded: boolean,
  onToggleSessionLogsExpanded: () => void,
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onLogFilterRolesChange: (next: SessionLogRole[]) => void,
  onLogFilterToolsChange: (next: string[]) => void,
  onLogFilterHasToolsChange: (next: boolean) => void,
  onLogFilterQueryChange: (next: string) => void,
  onLogFilterClear: () => void,
  contextExpanded: boolean,
  onToggleContextExpanded: () => void,
  onClose: () => void,
) {
  const label = session.label || session.key;
  const displayLabel = label.length > 50 ? label.slice(0, 50) + "…" : label;
  const usage = session.usage;

  return html`
    <div class="card session-detail-panel">
      <div class="session-detail-header">
        <div class="session-detail-header-left">
          <div class="session-detail-title">${displayLabel}</div>
        </div>
        <div class="session-detail-stats">
          ${
            usage
              ? html`
            <span><strong>${formatTokens(usage.totalTokens)}</strong> tokens</span>
            <span><strong>${formatCost(usage.totalCost)}</strong></span>
          `
              : nothing
          }
        </div>
        <button class="session-close-btn" @click=${onClose} title="Close session details">×</button>
      </div>
      <div class="session-detail-content">
        ${renderSessionSummary(session)}
        <div class="session-detail-row">
          ${renderTimeSeriesCompact(
            timeSeries,
            timeSeriesLoading,
            timeSeriesMode,
            onTimeSeriesModeChange,
            timeSeriesBreakdownMode,
            onTimeSeriesBreakdownChange,
            startDate,
            endDate,
            selectedDays,
          )}
        </div>
        <div class="session-detail-bottom">
          ${renderSessionLogsCompact(
            sessionLogs,
            sessionLogsLoading,
            sessionLogsExpanded,
            onToggleSessionLogsExpanded,
            logFilters,
            onLogFilterRolesChange,
            onLogFilterToolsChange,
            onLogFilterHasToolsChange,
            onLogFilterQueryChange,
            onLogFilterClear,
          )}
          ${renderContextPanel(session.contextWeight, usage, contextExpanded, onToggleContextExpanded)}
        </div>
      </div>
    </div>
  `;
}
