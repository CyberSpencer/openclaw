import { html, svg, nothing } from "lit";
import { formatDurationCompact } from "../../../../src/infra/format-time/format-duration.ts";
import { extractQueryTerms, filterSessionsByQuery, parseToolSummary } from "../usage-helpers.ts";
import {
  addQueryToken,
  applySuggestionToQuery,
  buildAggregatesFromSessions,
  buildDailyCsv,
  buildPeakErrorHours,
  buildQuerySuggestions,
  buildSessionsCsv,
  buildUsageInsightStats,
  charsToTokens,
  downloadTextFile,
  formatCost,
  formatDayLabel,
  formatFullDate,
  formatIsoDate,
  formatTokens,
  getZonedHour,
  normalizeQueryText,
  removeQueryToken,
  renderUsageMosaic,
  setQueryTokensForKey,
  setToHourEnd,
  type UsageInsightStats,
} from "./usage-shared.ts";
import { usageStylesString } from "./usageStyles.ts";
import {
  UsageSessionEntry,
  UsageTotals,
  UsageAggregates,
  CostDailyEntry,
  UsageColumnId,
  TimeSeriesPoint,
  SessionLogEntry,
  SessionLogRole,
  UsageProps,
} from "./usageTypes.ts";

export type { UsageColumnId, SessionLogEntry, SessionLogRole };

function pct(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return (part / total) * 100;
}

function getCostBreakdown(totals: UsageTotals) {
  // Use actual costs from API data (already aggregated in backend)
  const totalCost = totals.totalCost || 0;

  return {
    input: {
      tokens: totals.input,
      cost: totals.inputCost || 0,
      pct: pct(totals.inputCost || 0, totalCost),
    },
    output: {
      tokens: totals.output,
      cost: totals.outputCost || 0,
      pct: pct(totals.outputCost || 0, totalCost),
    },
    cacheRead: {
      tokens: totals.cacheRead,
      cost: totals.cacheReadCost || 0,
      pct: pct(totals.cacheReadCost || 0, totalCost),
    },
    cacheWrite: {
      tokens: totals.cacheWrite,
      cost: totals.cacheWriteCost || 0,
      pct: pct(totals.cacheWriteCost || 0, totalCost),
    },
    totalCost,
  };
}

function renderFilterChips(
  selectedDays: string[],
  selectedHours: number[],
  selectedSessions: string[],
  sessions: UsageSessionEntry[],
  onClearDays: () => void,
  onClearHours: () => void,
  onClearSessions: () => void,
  onClearFilters: () => void,
) {
  const hasFilters =
    selectedDays.length > 0 || selectedHours.length > 0 || selectedSessions.length > 0;
  if (!hasFilters) {
    return nothing;
  }

  const selectedSession =
    selectedSessions.length === 1 ? sessions.find((s) => s.key === selectedSessions[0]) : null;
  const sessionsLabel = selectedSession
    ? (selectedSession.label || selectedSession.key).slice(0, 20) +
      ((selectedSession.label || selectedSession.key).length > 20 ? "…" : "")
    : selectedSessions.length === 1
      ? selectedSessions[0].slice(0, 8) + "…"
      : `${selectedSessions.length} sessions`;
  const sessionsFullName = selectedSession
    ? selectedSession.label || selectedSession.key
    : selectedSessions.length === 1
      ? selectedSessions[0]
      : selectedSessions.join(", ");

  const daysLabel = selectedDays.length === 1 ? selectedDays[0] : `${selectedDays.length} days`;
  const hoursLabel =
    selectedHours.length === 1 ? `${selectedHours[0]}:00` : `${selectedHours.length} hours`;

  return html`
    <div class="active-filters">
      ${
        selectedDays.length > 0
          ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">Days: ${daysLabel}</span>
              <button class="filter-chip-remove" @click=${onClearDays} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        selectedHours.length > 0
          ? html`
            <div class="filter-chip">
              <span class="filter-chip-label">Hours: ${hoursLabel}</span>
              <button class="filter-chip-remove" @click=${onClearHours} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        selectedSessions.length > 0
          ? html`
            <div class="filter-chip" title="${sessionsFullName}">
              <span class="filter-chip-label">Session: ${sessionsLabel}</span>
              <button class="filter-chip-remove" @click=${onClearSessions} title="Remove filter">×</button>
            </div>
          `
          : nothing
      }
      ${
        (selectedDays.length > 0 || selectedHours.length > 0) && selectedSessions.length > 0
          ? html`
            <button class="btn btn-sm filter-clear-btn" @click=${onClearFilters}>
              Clear All
            </button>
          `
          : nothing
      }
    </div>
  `;
}

function renderDailyChartCompact(
  daily: CostDailyEntry[],
  selectedDays: string[],
  chartMode: "tokens" | "cost",
  dailyChartMode: "total" | "by-type",
  onDailyChartModeChange: (mode: "total" | "by-type") => void,
  onSelectDay: (day: string, shiftKey: boolean) => void,
) {
  if (!daily.length) {
    return html`
      <div class="daily-chart-compact">
        <div class="sessions-panel-title">Daily Usage</div>
        <div class="muted" style="padding: 20px; text-align: center">No data</div>
      </div>
    `;
  }

  const isTokenMode = chartMode === "tokens";
  const values = daily.map((d) => (isTokenMode ? d.totalTokens : d.totalCost));
  const maxValue = Math.max(...values, isTokenMode ? 1 : 0.0001);

  // Calculate bar width based on number of days
  const barMaxWidth = daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
  const showTotals = daily.length <= 14;

  return html`
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        <div class="chart-toggle small sessions-toggle">
          <button
            class="toggle-btn ${dailyChartMode === "total" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("total")}
          >
            Total
          </button>
          <button
            class="toggle-btn ${dailyChartMode === "by-type" ? "active" : ""}"
            @click=${() => onDailyChartModeChange("by-type")}
          >
            By Type
          </button>
        </div>
        <div class="card-title">Daily ${isTokenMode ? "Token" : "Cost"} Usage</div>
      </div>
      <div class="daily-chart">
        <div class="daily-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
          ${daily.map((d, idx) => {
            const value = values[idx];
            const heightPct = (value / maxValue) * 100;
            const isSelected = selectedDays.includes(d.date);
            const label = formatDayLabel(d.date);
            // Shorter label for many days (just day number)
            const shortLabel = daily.length > 20 ? String(parseInt(d.date.slice(8), 10)) : label;
            const labelStyle = daily.length > 20 ? "font-size: 8px" : "";
            const segments =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      { value: d.output, class: "output" },
                      { value: d.input, class: "input" },
                      { value: d.cacheWrite, class: "cache-write" },
                      { value: d.cacheRead, class: "cache-read" },
                    ]
                  : [
                      { value: d.outputCost ?? 0, class: "output" },
                      { value: d.inputCost ?? 0, class: "input" },
                      { value: d.cacheWriteCost ?? 0, class: "cache-write" },
                      { value: d.cacheReadCost ?? 0, class: "cache-read" },
                    ]
                : [];
            const breakdownLines =
              dailyChartMode === "by-type"
                ? isTokenMode
                  ? [
                      `Output ${formatTokens(d.output)}`,
                      `Input ${formatTokens(d.input)}`,
                      `Cache write ${formatTokens(d.cacheWrite)}`,
                      `Cache read ${formatTokens(d.cacheRead)}`,
                    ]
                  : [
                      `Output ${formatCost(d.outputCost ?? 0)}`,
                      `Input ${formatCost(d.inputCost ?? 0)}`,
                      `Cache write ${formatCost(d.cacheWriteCost ?? 0)}`,
                      `Cache read ${formatCost(d.cacheReadCost ?? 0)}`,
                    ]
                : [];
            const totalLabel = isTokenMode ? formatTokens(d.totalTokens) : formatCost(d.totalCost);
            return html`
              <div
                class="daily-bar-wrapper ${isSelected ? "selected" : ""}"
                @click=${(e: MouseEvent) => onSelectDay(d.date, e.shiftKey)}
              >
                ${
                  dailyChartMode === "by-type"
                    ? html`
                        <div
                          class="daily-bar"
                          style="height: ${heightPct.toFixed(1)}%; display: flex; flex-direction: column;"
                        >
                          ${(() => {
                            const total = segments.reduce((sum, seg) => sum + seg.value, 0) || 1;
                            return segments.map(
                              (seg) => html`
                                <div
                                  class="cost-segment ${seg.class}"
                                  style="height: ${(seg.value / total) * 100}%"
                                ></div>
                              `,
                            );
                          })()}
                        </div>
                      `
                    : html`
                        <div class="daily-bar" style="height: ${heightPct.toFixed(1)}%"></div>
                      `
                }
                ${showTotals ? html`<div class="daily-bar-total">${totalLabel}</div>` : nothing}
                <div class="daily-bar-label" style="${labelStyle}">${shortLabel}</div>
                <div class="daily-bar-tooltip">
                  <strong>${formatFullDate(d.date)}</strong><br />
                  ${formatTokens(d.totalTokens)} tokens<br />
                  ${formatCost(d.totalCost)}
                  ${
                    breakdownLines.length
                      ? html`${breakdownLines.map((line) => html`<div>${line}</div>`)}`
                      : nothing
                  }
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

function renderCostBreakdownCompact(totals: UsageTotals, mode: "tokens" | "cost") {
  const breakdown = getCostBreakdown(totals);
  const isTokenMode = mode === "tokens";
  const totalTokens = totals.totalTokens || 1;
  const tokenPcts = {
    output: pct(totals.output, totalTokens),
    input: pct(totals.input, totalTokens),
    cacheWrite: pct(totals.cacheWrite, totalTokens),
    cacheRead: pct(totals.cacheRead, totalTokens),
  };

  return html`
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">${isTokenMode ? "Tokens" : "Cost"} by Type</div>
      <div class="cost-breakdown-bar">
        <div class="cost-segment output" style="width: ${(isTokenMode ? tokenPcts.output : breakdown.output.pct).toFixed(1)}%"
          title="Output: ${isTokenMode ? formatTokens(totals.output) : formatCost(breakdown.output.cost)}"></div>
        <div class="cost-segment input" style="width: ${(isTokenMode ? tokenPcts.input : breakdown.input.pct).toFixed(1)}%"
          title="Input: ${isTokenMode ? formatTokens(totals.input) : formatCost(breakdown.input.cost)}"></div>
        <div class="cost-segment cache-write" style="width: ${(isTokenMode ? tokenPcts.cacheWrite : breakdown.cacheWrite.pct).toFixed(1)}%"
          title="Cache Write: ${isTokenMode ? formatTokens(totals.cacheWrite) : formatCost(breakdown.cacheWrite.cost)}"></div>
        <div class="cost-segment cache-read" style="width: ${(isTokenMode ? tokenPcts.cacheRead : breakdown.cacheRead.pct).toFixed(1)}%"
          title="Cache Read: ${isTokenMode ? formatTokens(totals.cacheRead) : formatCost(breakdown.cacheRead.cost)}"></div>
      </div>
      <div class="cost-breakdown-legend">
        <span class="legend-item"><span class="legend-dot output"></span>Output ${isTokenMode ? formatTokens(totals.output) : formatCost(breakdown.output.cost)}</span>
        <span class="legend-item"><span class="legend-dot input"></span>Input ${isTokenMode ? formatTokens(totals.input) : formatCost(breakdown.input.cost)}</span>
        <span class="legend-item"><span class="legend-dot cache-write"></span>Cache Write ${isTokenMode ? formatTokens(totals.cacheWrite) : formatCost(breakdown.cacheWrite.cost)}</span>
        <span class="legend-item"><span class="legend-dot cache-read"></span>Cache Read ${isTokenMode ? formatTokens(totals.cacheRead) : formatCost(breakdown.cacheRead.cost)}</span>
      </div>
      <div class="cost-breakdown-total">
        Total: ${isTokenMode ? formatTokens(totals.totalTokens) : formatCost(totals.totalCost)}
      </div>
    </div>
  `;
}

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

function renderPeakErrorList(
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
              <div class="usage-error-list">
                ${items.map(
                  (item) => html`
                    <div class="usage-error-row">
                      <div class="usage-error-date">${item.label}</div>
                      <div class="usage-error-rate">${item.value}</div>
                      ${item.sub ? html`<div class="usage-error-sub">${item.sub}</div>` : nothing}
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

function renderUsageInsights(
  totals: UsageTotals | null,
  aggregates: UsageAggregates,
  stats: UsageInsightStats,
  showCostHint: boolean,
  errorHours: Array<{ label: string; value: string; sub?: string }>,
  sessionCount: number,
  totalSessions: number,
) {
  if (!totals) {
    return nothing;
  }

  const avgTokens = aggregates.messages.total
    ? Math.round(totals.totalTokens / aggregates.messages.total)
    : 0;
  const avgCost = aggregates.messages.total ? totals.totalCost / aggregates.messages.total : 0;
  const cacheBase = totals.input + totals.cacheRead;
  const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
  const cacheHitLabel = cacheBase > 0 ? `${(cacheHitRate * 100).toFixed(1)}%` : "—";
  const errorRatePct = stats.errorRate * 100;
  const throughputLabel =
    stats.throughputTokensPerMin !== undefined
      ? `${formatTokens(Math.round(stats.throughputTokensPerMin))} tok/min`
      : "—";
  const throughputCostLabel =
    stats.throughputCostPerMin !== undefined
      ? `${formatCost(stats.throughputCostPerMin, 4)} / min`
      : "—";
  const avgDurationLabel =
    stats.durationCount > 0
      ? (formatDurationCompact(stats.avgDurationMs, { spaced: true }) ?? "—")
      : "—";
  const cacheHint = "Cache hit rate = cache read / (input + cache read). Higher is better.";
  const errorHint = "Error rate = errors / total messages. Lower is better.";
  const throughputHint = "Throughput shows tokens per minute over active time. Higher is better.";
  const tokensHint = "Average tokens per message in this range.";
  const costHint = showCostHint
    ? "Average cost per message when providers report costs. Cost data is missing for some or all sessions in this range."
    : "Average cost per message when providers report costs.";

  const errorDays = aggregates.daily
    .filter((day) => day.messages > 0 && day.errors > 0)
    .map((day) => {
      const rate = day.errors / day.messages;
      return {
        label: formatDayLabel(day.date),
        value: `${(rate * 100).toFixed(2)}%`,
        sub: `${day.errors} errors · ${day.messages} msgs · ${formatTokens(day.tokens)}`,
        rate,
      };
    })
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map(({ rate: _rate, ...rest }) => rest);

  const topModels = aggregates.byModel.slice(0, 5).map((entry) => ({
    label: entry.model ?? "unknown",
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} msgs`,
  }));
  const topProviders = aggregates.byProvider.slice(0, 5).map((entry) => ({
    label: entry.provider ?? "unknown",
    value: formatCost(entry.totals.totalCost),
    sub: `${formatTokens(entry.totals.totalTokens)} · ${entry.count} msgs`,
  }));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: "calls",
  }));
  const topAgents = aggregates.byAgent.slice(0, 5).map((entry) => ({
    label: entry.agentId,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));
  const topChannels = aggregates.byChannel.slice(0, 5).map((entry) => ({
    label: entry.channel,
    value: formatCost(entry.totals.totalCost),
    sub: formatTokens(entry.totals.totalTokens),
  }));

  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">Usage Overview</div>
      <div class="usage-summary-grid">
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Messages
            <span class="usage-summary-hint" title="Total user + assistant messages in range.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.messages.total}</div>
          <div class="usage-summary-sub">
            ${aggregates.messages.user} user · ${aggregates.messages.assistant} assistant
          </div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Tool Calls
            <span class="usage-summary-hint" title="Total tool call count across sessions.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.tools.totalCalls}</div>
          <div class="usage-summary-sub">${aggregates.tools.uniqueTools} tools used</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Errors
            <span class="usage-summary-hint" title="Total message/tool errors in range.">?</span>
          </div>
          <div class="usage-summary-value">${aggregates.messages.errors}</div>
          <div class="usage-summary-sub">${aggregates.messages.toolResults} tool results</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Avg Tokens / Msg
            <span class="usage-summary-hint" title=${tokensHint}>?</span>
          </div>
          <div class="usage-summary-value">${formatTokens(avgTokens)}</div>
          <div class="usage-summary-sub">Across ${aggregates.messages.total || 0} messages</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Avg Cost / Msg
            <span class="usage-summary-hint" title=${costHint}>?</span>
          </div>
          <div class="usage-summary-value">${formatCost(avgCost, 4)}</div>
          <div class="usage-summary-sub">${formatCost(totals.totalCost)} total</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Sessions
            <span class="usage-summary-hint" title="Distinct sessions in the range.">?</span>
          </div>
          <div class="usage-summary-value">${sessionCount}</div>
          <div class="usage-summary-sub">of ${totalSessions} in range</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Throughput
            <span class="usage-summary-hint" title=${throughputHint}>?</span>
          </div>
          <div class="usage-summary-value">${throughputLabel}</div>
          <div class="usage-summary-sub">${throughputCostLabel}</div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Error Rate
            <span class="usage-summary-hint" title=${errorHint}>?</span>
          </div>
          <div class="usage-summary-value ${errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good"}">${errorRatePct.toFixed(2)}%</div>
          <div class="usage-summary-sub">
            ${aggregates.messages.errors} errors · ${avgDurationLabel} avg session
          </div>
        </div>
        <div class="usage-summary-card">
          <div class="usage-summary-title">
            Cache Hit Rate
            <span class="usage-summary-hint" title=${cacheHint}>?</span>
          </div>
          <div class="usage-summary-value ${cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad"}">${cacheHitLabel}</div>
          <div class="usage-summary-sub">
            ${formatTokens(totals.cacheRead)} cached · ${formatTokens(cacheBase)} prompt
          </div>
        </div>
      </div>
      <div class="usage-insights-grid">
        ${renderInsightList("Top Models", topModels, "No model data")}
        ${renderInsightList("Top Providers", topProviders, "No provider data")}
        ${renderInsightList("Top Tools", topTools, "No tool calls")}
        ${renderInsightList("Top Agents", topAgents, "No agent data")}
        ${renderInsightList("Top Channels", topChannels, "No channel data")}
        ${renderPeakErrorList("Peak Error Days", errorDays, "No error data")}
        ${renderPeakErrorList("Peak Error Hours", errorHours, "No error data")}
      </div>
    </section>
  `;
}

function renderSessionsCard(
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

function renderEmptyDetailState() {
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

function renderSessionDetailPanel(
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

function renderTimeSeriesCompact(
  timeSeries: { points: TimeSeriesPoint[] } | null,
  loading: boolean,
  mode: "cumulative" | "per-turn",
  onModeChange: (mode: "cumulative" | "per-turn") => void,
  breakdownMode: "total" | "by-type",
  onBreakdownChange: (mode: "total" | "by-type") => void,
  startDate?: string,
  endDate?: string,
  selectedDays?: string[],
) {
  if (loading) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">Loading...</div>
      </div>
    `;
  }
  if (!timeSeries || timeSeries.points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">No timeline data</div>
      </div>
    `;
  }

  // Filter and recalculate (same logic as main function)
  let points = timeSeries.points;
  if (startDate || endDate || (selectedDays && selectedDays.length > 0)) {
    const startTs = startDate ? new Date(startDate + "T00:00:00").getTime() : 0;
    const endTs = endDate ? new Date(endDate + "T23:59:59").getTime() : Infinity;
    points = timeSeries.points.filter((p) => {
      if (p.timestamp < startTs || p.timestamp > endTs) {
        return false;
      }
      if (selectedDays && selectedDays.length > 0) {
        const d = new Date(p.timestamp);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return selectedDays.includes(dateStr);
      }
      return true;
    });
  }
  if (points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        <div class="muted" style="padding: 20px; text-align: center">No data in range</div>
      </div>
    `;
  }
  let cumTokens = 0,
    cumCost = 0;
  let sumOutput = 0;
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  points = points.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    sumOutput += p.output;
    sumInput += p.input;
    sumCacheRead += p.cacheRead;
    sumCacheWrite += p.cacheWrite;
    return { ...p, cumulativeTokens: cumTokens, cumulativeCost: cumCost };
  });

  const width = 400,
    height = 80;
  const padding = { top: 16, right: 10, bottom: 20, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const totalTypeTokens = sumOutput + sumInput + sumCacheRead + sumCacheWrite;
  const barTotals = points.map((p) =>
    isCumulative
      ? p.cumulativeTokens
      : breakdownByType
        ? p.input + p.output + p.cacheRead + p.cacheWrite
        : p.totalTokens,
  );
  const maxValue = Math.max(...barTotals, 1);
  const barWidth = Math.max(2, Math.min(8, (chartWidth / points.length) * 0.7));
  const barGap = Math.max(1, (chartWidth - barWidth * points.length) / (points.length - 1 || 1));

  return html`
    <div class="session-timeseries-compact">
      <div class="timeseries-header-row">
        <div class="card-title" style="font-size: 13px;">Usage Over Time</div>
        <div class="timeseries-controls">
          <div class="chart-toggle small">
            <button
              class="toggle-btn ${!isCumulative ? "active" : ""}"
              @click=${() => onModeChange("per-turn")}
            >
              Per Turn
            </button>
            <button
              class="toggle-btn ${isCumulative ? "active" : ""}"
              @click=${() => onModeChange("cumulative")}
            >
              Cumulative
            </button>
          </div>
          ${
            !isCumulative
              ? html`
                  <div class="chart-toggle small">
                    <button
                      class="toggle-btn ${breakdownMode === "total" ? "active" : ""}"
                      @click=${() => onBreakdownChange("total")}
                    >
                      Total
                    </button>
                    <button
                      class="toggle-btn ${breakdownMode === "by-type" ? "active" : ""}"
                      @click=${() => onBreakdownChange("by-type")}
                    >
                      By Type
                    </button>
                  </div>
                `
              : nothing
          }
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${height + 15}" class="timeseries-svg" style="width: 100%; height: auto;">
        <!-- Y axis -->
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="var(--border)" />
        <!-- X axis -->
        <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="var(--border)" />
        <!-- Y axis labels -->
        <text x="${padding.left - 4}" y="${padding.top + 4}" text-anchor="end" class="axis-label" style="font-size: 9px; fill: var(--text-muted)">${formatTokens(maxValue)}</text>
        <text x="${padding.left - 4}" y="${padding.top + chartHeight}" text-anchor="end" class="axis-label" style="font-size: 9px; fill: var(--text-muted)">0</text>
        <!-- X axis labels (first and last) -->
        ${
          points.length > 0
            ? svg`
          <text x="${padding.left}" y="${padding.top + chartHeight + 12}" text-anchor="start" style="font-size: 8px; fill: var(--text-muted)">${new Date(points[0].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>
          <text x="${width - padding.right}" y="${padding.top + chartHeight + 12}" text-anchor="end" style="font-size: 8px; fill: var(--text-muted)">${new Date(points[points.length - 1].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>
        `
            : nothing
        }
        <!-- Bars -->
        ${points.map((p, i) => {
          const val = barTotals[i];
          const x = padding.left + i * (barWidth + barGap);
          const barHeight = (val / maxValue) * chartHeight;
          const y = padding.top + chartHeight - barHeight;
          const date = new Date(p.timestamp);
          const tooltipLines = [
            date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            `${formatTokens(val)} tokens`,
          ];
          if (breakdownByType) {
            tooltipLines.push(`Output ${formatTokens(p.output)}`);
            tooltipLines.push(`Input ${formatTokens(p.input)}`);
            tooltipLines.push(`Cache write ${formatTokens(p.cacheWrite)}`);
            tooltipLines.push(`Cache read ${formatTokens(p.cacheRead)}`);
          }
          const tooltip = tooltipLines.join(" · ");
          if (!breakdownByType) {
            return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" class="ts-bar" rx="1" style="cursor: pointer;"><title>${tooltip}</title></rect>`;
          }
          const segments = [
            { value: p.output, class: "output" },
            { value: p.input, class: "input" },
            { value: p.cacheWrite, class: "cache-write" },
            { value: p.cacheRead, class: "cache-read" },
          ];
          let yCursor = padding.top + chartHeight;
          return svg`
            ${segments.map((seg) => {
              if (seg.value <= 0 || val <= 0) {
                return nothing;
              }
              const segHeight = barHeight * (seg.value / val);
              yCursor -= segHeight;
              return svg`<rect x="${x}" y="${yCursor}" width="${barWidth}" height="${segHeight}" class="ts-bar ${seg.class}" rx="1"><title>${tooltip}</title></rect>`;
            })}
          `;
        })}
      </svg>
      <div class="timeseries-summary">${points.length} msgs · ${formatTokens(cumTokens)} · ${formatCost(cumCost)}</div>
      ${
        breakdownByType
          ? html`
              <div style="margin-top: 8px;">
                <div class="card-title" style="font-size: 12px; margin-bottom: 6px;">Tokens by Type</div>
                <div class="cost-breakdown-bar" style="height: 18px;">
                  <div class="cost-segment output" style="width: ${pct(sumOutput, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment input" style="width: ${pct(sumInput, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment cache-write" style="width: ${pct(sumCacheWrite, totalTypeTokens).toFixed(1)}%"></div>
                  <div class="cost-segment cache-read" style="width: ${pct(sumCacheRead, totalTypeTokens).toFixed(1)}%"></div>
                </div>
                <div class="cost-breakdown-legend">
                  <div class="legend-item" title="Assistant output tokens">
                    <span class="legend-dot output"></span>Output ${formatTokens(sumOutput)}
                  </div>
                  <div class="legend-item" title="User + tool input tokens">
                    <span class="legend-dot input"></span>Input ${formatTokens(sumInput)}
                  </div>
                  <div class="legend-item" title="Tokens written to cache">
                    <span class="legend-dot cache-write"></span>Cache Write ${formatTokens(sumCacheWrite)}
                  </div>
                  <div class="legend-item" title="Tokens read from cache">
                    <span class="legend-dot cache-read"></span>Cache Read ${formatTokens(sumCacheRead)}
                  </div>
                </div>
                <div class="cost-breakdown-total">Total: ${formatTokens(totalTypeTokens)}</div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderContextPanel(
  contextWeight: UsageSessionEntry["contextWeight"],
  usage: UsageSessionEntry["usage"],
  expanded: boolean,
  onToggleExpanded: () => void,
) {
  if (!contextWeight) {
    return html`
      <div class="context-details-panel">
        <div class="muted" style="padding: 20px; text-align: center">No context data</div>
      </div>
    `;
  }
  const systemTokens = charsToTokens(contextWeight.systemPrompt.chars);
  const skillsTokens = charsToTokens(contextWeight.skills.promptChars);
  const toolsTokens = charsToTokens(
    contextWeight.tools.listChars + contextWeight.tools.schemaChars,
  );
  const filesTokens = charsToTokens(
    contextWeight.injectedWorkspaceFiles.reduce((sum, f) => sum + f.injectedChars, 0),
  );
  const totalContextTokens = systemTokens + skillsTokens + toolsTokens + filesTokens;

  let contextPct = "";
  if (usage && usage.totalTokens > 0) {
    const inputTokens = usage.input + usage.cacheRead;
    if (inputTokens > 0) {
      contextPct = `~${Math.min((totalContextTokens / inputTokens) * 100, 100).toFixed(0)}% of input`;
    }
  }

  const skillsList = contextWeight.skills.entries.toSorted((a, b) => b.blockChars - a.blockChars);
  const toolsList = contextWeight.tools.entries.toSorted(
    (a, b) => b.summaryChars + b.schemaChars - (a.summaryChars + a.schemaChars),
  );
  const filesList = contextWeight.injectedWorkspaceFiles.toSorted(
    (a, b) => b.injectedChars - a.injectedChars,
  );
  const defaultLimit = 4;
  const showAll = expanded;
  const skillsTop = showAll ? skillsList : skillsList.slice(0, defaultLimit);
  const toolsTop = showAll ? toolsList : toolsList.slice(0, defaultLimit);
  const filesTop = showAll ? filesList : filesList.slice(0, defaultLimit);
  const hasMore =
    skillsList.length > defaultLimit ||
    toolsList.length > defaultLimit ||
    filesList.length > defaultLimit;

  return html`
    <div class="context-details-panel">
      <div class="context-breakdown-header">
        <div class="card-title" style="font-size: 13px;">System Prompt Breakdown</div>
        ${
          hasMore
            ? html`<button class="context-expand-btn" @click=${onToggleExpanded}>
                ${showAll ? "Collapse" : "Expand all"}
              </button>`
            : nothing
        }
      </div>
      <p class="context-weight-desc">${contextPct || "Base context per message"}</p>
      <div class="context-stacked-bar">
        <div class="context-segment system" style="width: ${pct(systemTokens, totalContextTokens).toFixed(1)}%" title="System: ~${formatTokens(systemTokens)}"></div>
        <div class="context-segment skills" style="width: ${pct(skillsTokens, totalContextTokens).toFixed(1)}%" title="Skills: ~${formatTokens(skillsTokens)}"></div>
        <div class="context-segment tools" style="width: ${pct(toolsTokens, totalContextTokens).toFixed(1)}%" title="Tools: ~${formatTokens(toolsTokens)}"></div>
        <div class="context-segment files" style="width: ${pct(filesTokens, totalContextTokens).toFixed(1)}%" title="Files: ~${formatTokens(filesTokens)}"></div>
      </div>
      <div class="context-legend">
        <span class="legend-item"><span class="legend-dot system"></span>Sys ~${formatTokens(systemTokens)}</span>
        <span class="legend-item"><span class="legend-dot skills"></span>Skills ~${formatTokens(skillsTokens)}</span>
        <span class="legend-item"><span class="legend-dot tools"></span>Tools ~${formatTokens(toolsTokens)}</span>
        <span class="legend-item"><span class="legend-dot files"></span>Files ~${formatTokens(filesTokens)}</span>
      </div>
      <div class="context-total">Total: ~${formatTokens(totalContextTokens)}</div>
      <div class="context-breakdown-grid">
        ${
          skillsList.length > 0
            ? (() => {
                const more = skillsList.length - skillsTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Skills (${skillsList.length})</div>
                    <div class="context-breakdown-list">
                      ${skillsTop.map(
                        (s) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${s.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(s.blockChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
        ${
          toolsList.length > 0
            ? (() => {
                const more = toolsList.length - toolsTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Tools (${toolsList.length})</div>
                    <div class="context-breakdown-list">
                      ${toolsTop.map(
                        (t) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${t.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(t.summaryChars + t.schemaChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
        ${
          filesList.length > 0
            ? (() => {
                const more = filesList.length - filesTop.length;
                return html`
                  <div class="context-breakdown-card">
                    <div class="context-breakdown-title">Files (${filesList.length})</div>
                    <div class="context-breakdown-list">
                      ${filesTop.map(
                        (f) => html`
                          <div class="context-breakdown-item">
                            <span class="mono">${f.name}</span>
                            <span class="muted">~${formatTokens(charsToTokens(f.injectedChars))}</span>
                          </div>
                        `,
                      )}
                    </div>
                    ${
                      more > 0
                        ? html`<div class="context-breakdown-more">+${more} more</div>`
                        : nothing
                    }
                  </div>
                `;
              })()
            : nothing
        }
      </div>
    </div>
  `;
}

function renderSessionLogsCompact(
  logs: SessionLogEntry[] | null,
  loading: boolean,
  expandedAll: boolean,
  onToggleExpandedAll: () => void,
  filters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onFilterRolesChange: (next: SessionLogRole[]) => void,
  onFilterToolsChange: (next: string[]) => void,
  onFilterHasToolsChange: (next: boolean) => void,
  onFilterQueryChange: (next: string) => void,
  onFilterClear: () => void,
) {
  if (loading) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">Conversation</div>
        <div class="muted" style="padding: 20px; text-align: center">Loading...</div>
      </div>
    `;
  }
  if (!logs || logs.length === 0) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">Conversation</div>
        <div class="muted" style="padding: 20px; text-align: center">No messages</div>
      </div>
    `;
  }

  const normalizedQuery = filters.query.trim().toLowerCase();
  const entries = logs.map((log) => {
    const toolInfo = parseToolSummary(log.content);
    const cleanContent = toolInfo.cleanContent || log.content;
    return { log, toolInfo, cleanContent };
  });
  const toolOptions = Array.from(
    new Set(entries.flatMap((entry) => entry.toolInfo.tools.map(([name]) => name))),
  ).toSorted((a, b) => a.localeCompare(b));
  const filteredEntries = entries.filter((entry) => {
    if (filters.roles.length > 0 && !filters.roles.includes(entry.log.role)) {
      return false;
    }
    if (filters.hasTools && entry.toolInfo.tools.length === 0) {
      return false;
    }
    if (filters.tools.length > 0) {
      const matchesTool = entry.toolInfo.tools.some(([name]) => filters.tools.includes(name));
      if (!matchesTool) {
        return false;
      }
    }
    if (normalizedQuery) {
      const haystack = entry.cleanContent.toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
    }
    return true;
  });
  const displayedCount =
    filters.roles.length > 0 || filters.tools.length > 0 || filters.hasTools || normalizedQuery
      ? `${filteredEntries.length} of ${logs.length}`
      : `${logs.length}`;

  const roleSelected = new Set(filters.roles);
  const toolSelected = new Set(filters.tools);

  return html`
    <div class="session-logs-compact">
      <div class="session-logs-header">
        <span>Conversation <span style="font-weight: normal; color: var(--text-muted);">(${displayedCount} messages)</span></span>
        <button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${onToggleExpandedAll}>
          ${expandedAll ? "Collapse All" : "Expand All"}
        </button>
      </div>
      <div class="usage-filters-inline" style="margin: 10px 12px;">
        <select
          multiple
          size="4"
          @change=${(event: Event) =>
            onFilterRolesChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value as SessionLogRole,
              ),
            )}
        >
          <option value="user" ?selected=${roleSelected.has("user")}>User</option>
          <option value="assistant" ?selected=${roleSelected.has("assistant")}>Assistant</option>
          <option value="tool" ?selected=${roleSelected.has("tool")}>Tool</option>
          <option value="toolResult" ?selected=${roleSelected.has("toolResult")}>Tool result</option>
        </select>
        <select
          multiple
          size="4"
          @change=${(event: Event) =>
            onFilterToolsChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value,
              ),
            )}
        >
          ${toolOptions.map(
            (tool) =>
              html`<option value=${tool} ?selected=${toolSelected.has(tool)}>${tool}</option>`,
          )}
        </select>
        <label class="usage-filters-inline" style="gap: 6px;">
          <input
            type="checkbox"
            .checked=${filters.hasTools}
            @change=${(event: Event) =>
              onFilterHasToolsChange((event.target as HTMLInputElement).checked)}
          />
          Has tools
        </label>
        <input
          type="text"
          placeholder="Search conversation"
          .value=${filters.query}
          @input=${(event: Event) => onFilterQueryChange((event.target as HTMLInputElement).value)}
        />
        <button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${onFilterClear}>
          Clear
        </button>
      </div>
      <div class="session-logs-list">
        ${filteredEntries.map((entry) => {
          const { log, toolInfo, cleanContent } = entry;
          const roleClass = log.role === "user" ? "user" : "assistant";
          const roleLabel =
            log.role === "user" ? "You" : log.role === "assistant" ? "Assistant" : "Tool";
          return html`
          <div class="session-log-entry ${roleClass}">
            <div class="session-log-meta">
              <span class="session-log-role">${roleLabel}</span>
              <span>${new Date(log.timestamp).toLocaleString()}</span>
              ${log.tokens ? html`<span>${formatTokens(log.tokens)}</span>` : nothing}
            </div>
            <div class="session-log-content">${cleanContent}</div>
            ${
              toolInfo.tools.length > 0
                ? html`
                    <details class="session-log-tools" ?open=${expandedAll}>
                      <summary>${toolInfo.summary}</summary>
                      <div class="session-log-tools-list">
                        ${toolInfo.tools.map(
                          ([name, count]) => html`
                            <span class="session-log-tools-pill">${name} × ${count}</span>
                          `,
                        )}
                      </div>
                    </details>
                  `
                : nothing
            }
          </div>
        `;
        })}
        ${
          filteredEntries.length === 0
            ? html`
                <div class="muted" style="padding: 12px">No messages match the filters.</div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

export function renderUsage(props: UsageProps) {
  // Show loading skeleton if loading and no data yet
  if (props.loading && !props.totals) {
    // Use inline styles since main stylesheet hasn't loaded yet on initial render
    return html`
      <style>
        @keyframes initial-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes initial-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      </style>
      <section class="card">
        <div class="row" style="justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
          <div style="flex: 1; min-width: 250px;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 2px;">
              <div class="card-title" style="margin: 0;">Token Usage</div>
              <span style="
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                background: rgba(255, 77, 77, 0.1);
                border-radius: 4px;
                font-size: 12px;
                color: #ff4d4d;
              ">
                <span style="
                  width: 10px;
                  height: 10px;
                  border: 2px solid #ff4d4d;
                  border-top-color: transparent;
                  border-radius: 50%;
                  animation: initial-spin 0.6s linear infinite;
                "></span>
                Loading
              </span>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="date" .value=${props.startDate} disabled style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 13px; opacity: 0.6;" />
              <span style="color: var(--text-muted);">to</span>
              <input type="date" .value=${props.endDate} disabled style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 13px; opacity: 0.6;" />
            </div>
          </div>
        </div>
      </section>
    `;
  }

  const isTokenMode = props.chartMode === "tokens";
  const hasQuery = props.query.trim().length > 0;
  const hasDraftQuery = props.queryDraft.trim().length > 0;
  // (intentionally no global Clear button in the header; chips + query clear handle this)

  // Sort sessions by tokens or cost depending on mode
  const sortedSessions = [...props.sessions].toSorted((a, b) => {
    const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
    const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
    return valB - valA;
  });

  // Filter sessions by selected days
  const dayFilteredSessions =
    props.selectedDays.length > 0
      ? sortedSessions.filter((s) => {
          if (s.usage?.activityDates?.length) {
            return s.usage.activityDates.some((d) => props.selectedDays.includes(d));
          }
          if (!s.updatedAt) {
            return false;
          }
          const d = new Date(s.updatedAt);
          const sessionDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return props.selectedDays.includes(sessionDate);
        })
      : sortedSessions;

  const sessionTouchesHours = (session: UsageSessionEntry, hours: number[]): boolean => {
    if (hours.length === 0) {
      return true;
    }
    const usage = session.usage;
    const start = usage?.firstActivity ?? session.updatedAt;
    const end = usage?.lastActivity ?? session.updatedAt;
    if (!start || !end) {
      return false;
    }
    const startMs = Math.min(start, end);
    const endMs = Math.max(start, end);
    let cursor = startMs;
    while (cursor <= endMs) {
      const date = new Date(cursor);
      const hour = getZonedHour(date, props.timeZone);
      if (hours.includes(hour)) {
        return true;
      }
      const nextHour = setToHourEnd(date, props.timeZone);
      const nextMs = Math.min(nextHour.getTime(), endMs);
      cursor = nextMs + 1;
    }
    return false;
  };

  const hourFilteredSessions =
    props.selectedHours.length > 0
      ? dayFilteredSessions.filter((s) => sessionTouchesHours(s, props.selectedHours))
      : dayFilteredSessions;

  // Filter sessions by query (client-side)
  const queryResult = filterSessionsByQuery(hourFilteredSessions, props.query);
  const filteredSessions = queryResult.sessions;
  const queryWarnings = queryResult.warnings;
  const querySuggestions = buildQuerySuggestions(
    props.queryDraft,
    sortedSessions,
    props.aggregates,
  );
  const queryTerms = extractQueryTerms(props.query);
  const selectedValuesFor = (key: string): string[] => {
    const normalized = normalizeQueryText(key);
    return queryTerms
      .filter((term) => normalizeQueryText(term.key ?? "") === normalized)
      .map((term) => term.value)
      .filter(Boolean);
  };
  const unique = (items: Array<string | undefined>) => {
    const set = new Set<string>();
    for (const item of items) {
      if (item) {
        set.add(item);
      }
    }
    return Array.from(set);
  };
  const agentOptions = unique(sortedSessions.map((s) => s.agentId)).slice(0, 12);
  const channelOptions = unique(sortedSessions.map((s) => s.channel)).slice(0, 12);
  const providerOptions = unique([
    ...sortedSessions.map((s) => s.modelProvider),
    ...sortedSessions.map((s) => s.providerOverride),
    ...(props.aggregates?.byProvider.map((entry) => entry.provider) ?? []),
  ]).slice(0, 12);
  const modelOptions = unique([
    ...sortedSessions.map((s) => s.model),
    ...(props.aggregates?.byModel.map((entry) => entry.model) ?? []),
  ]).slice(0, 12);
  const toolOptions = unique(props.aggregates?.tools.tools.map((tool) => tool.name) ?? []).slice(
    0,
    12,
  );

  // Get first selected session for detail view (timeseries, logs)
  const primarySelectedEntry =
    props.selectedSessions.length === 1
      ? (props.sessions.find((s) => s.key === props.selectedSessions[0]) ??
        filteredSessions.find((s) => s.key === props.selectedSessions[0]))
      : null;

  // Compute totals from sessions
  const computeSessionTotals = (sessions: UsageSessionEntry[]): UsageTotals => {
    return sessions.reduce(
      (acc, s) => {
        if (s.usage) {
          acc.input += s.usage.input;
          acc.output += s.usage.output;
          acc.cacheRead += s.usage.cacheRead;
          acc.cacheWrite += s.usage.cacheWrite;
          acc.totalTokens += s.usage.totalTokens;
          acc.totalCost += s.usage.totalCost;
          acc.inputCost += s.usage.inputCost ?? 0;
          acc.outputCost += s.usage.outputCost ?? 0;
          acc.cacheReadCost += s.usage.cacheReadCost ?? 0;
          acc.cacheWriteCost += s.usage.cacheWriteCost ?? 0;
          acc.missingCostEntries += s.usage.missingCostEntries ?? 0;
        }
        return acc;
      },
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    );
  };

  // Compute totals from daily data for selected days (more accurate than session totals)
  const computeDailyTotals = (days: string[]): UsageTotals => {
    const matchingDays = props.costDaily.filter((d) => days.includes(d.date));
    return matchingDays.reduce(
      (acc, d) => {
        acc.input += d.input;
        acc.output += d.output;
        acc.cacheRead += d.cacheRead;
        acc.cacheWrite += d.cacheWrite;
        acc.totalTokens += d.totalTokens;
        acc.totalCost += d.totalCost;
        acc.inputCost += d.inputCost ?? 0;
        acc.outputCost += d.outputCost ?? 0;
        acc.cacheReadCost += d.cacheReadCost ?? 0;
        acc.cacheWriteCost += d.cacheWriteCost ?? 0;
        return acc;
      },
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    );
  };

  // Compute display totals and count based on filters
  let displayTotals: UsageTotals | null;
  let displaySessionCount: number;
  const totalSessions = sortedSessions.length;

  if (props.selectedSessions.length > 0) {
    // Sessions selected - compute totals from selected sessions
    const selectedSessionEntries = filteredSessions.filter((s) =>
      props.selectedSessions.includes(s.key),
    );
    displayTotals = computeSessionTotals(selectedSessionEntries);
    displaySessionCount = selectedSessionEntries.length;
  } else if (props.selectedDays.length > 0 && props.selectedHours.length === 0) {
    // Days selected - use daily aggregates for accurate per-day totals
    displayTotals = computeDailyTotals(props.selectedDays);
    displaySessionCount = filteredSessions.length;
  } else if (props.selectedHours.length > 0) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else if (hasQuery) {
    displayTotals = computeSessionTotals(filteredSessions);
    displaySessionCount = filteredSessions.length;
  } else {
    // No filters - show all
    displayTotals = props.totals;
    displaySessionCount = totalSessions;
  }

  const aggregateSessions =
    props.selectedSessions.length > 0
      ? filteredSessions.filter((s) => props.selectedSessions.includes(s.key))
      : hasQuery || props.selectedHours.length > 0
        ? filteredSessions
        : props.selectedDays.length > 0
          ? dayFilteredSessions
          : sortedSessions;
  const activeAggregates = buildAggregatesFromSessions(aggregateSessions, props.aggregates);

  // Filter daily chart data if sessions are selected
  const filteredDaily =
    props.selectedSessions.length > 0
      ? (() => {
          const selectedEntries = filteredSessions.filter((s) =>
            props.selectedSessions.includes(s.key),
          );
          const allActivityDates = new Set<string>();
          for (const entry of selectedEntries) {
            for (const date of entry.usage?.activityDates ?? []) {
              allActivityDates.add(date);
            }
          }
          return allActivityDates.size > 0
            ? props.costDaily.filter((d) => allActivityDates.has(d.date))
            : props.costDaily;
        })()
      : props.costDaily;

  const insightStats = buildUsageInsightStats(aggregateSessions, displayTotals, activeAggregates);
  const isEmpty = !props.loading && !props.totals && props.sessions.length === 0;
  const hasMissingCost =
    (displayTotals?.missingCostEntries ?? 0) > 0 ||
    (displayTotals
      ? displayTotals.totalTokens > 0 &&
        displayTotals.totalCost === 0 &&
        displayTotals.input +
          displayTotals.output +
          displayTotals.cacheRead +
          displayTotals.cacheWrite >
          0
      : false);
  const datePresets = [
    { label: "Today", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
  ];
  const applyPreset = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    props.onStartDateChange(formatIsoDate(start));
    props.onEndDateChange(formatIsoDate(end));
  };
  const renderFilterSelect = (key: string, label: string, options: string[]) => {
    if (options.length === 0) {
      return nothing;
    }
    const selected = selectedValuesFor(key);
    const selectedSet = new Set(selected.map((value) => normalizeQueryText(value)));
    const allSelected =
      options.length > 0 && options.every((value) => selectedSet.has(normalizeQueryText(value)));
    const selectedCount = selected.length;
    return html`
      <details
        class="usage-filter-select"
        @toggle=${(e: Event) => {
          const el = e.currentTarget as HTMLDetailsElement;
          if (!el.open) {
            return;
          }
          const onClick = (ev: MouseEvent) => {
            const path = ev.composedPath();
            if (!path.includes(el)) {
              el.open = false;
              window.removeEventListener("click", onClick, true);
            }
          };
          window.addEventListener("click", onClick, true);
        }}
      >
        <summary>
          <span>${label}</span>
          ${
            selectedCount > 0
              ? html`<span class="usage-filter-badge">${selectedCount}</span>`
              : html`
                  <span class="usage-filter-badge">All</span>
                `
          }
        </summary>
        <div class="usage-filter-popover">
          <div class="usage-filter-actions">
            <button
              class="btn btn-sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, key, options));
              }}
              ?disabled=${allSelected}
            >
              Select All
            </button>
            <button
              class="btn btn-sm"
              @click=${(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, key, []));
              }}
              ?disabled=${selectedCount === 0}
            >
              Clear
            </button>
          </div>
          <div class="usage-filter-options">
            ${options.map((value) => {
              const checked = selectedSet.has(normalizeQueryText(value));
              return html`
                <label class="usage-filter-option">
                  <input
                    type="checkbox"
                    .checked=${checked}
                    @change=${(e: Event) => {
                      const target = e.target as HTMLInputElement;
                      const token = `${key}:${value}`;
                      props.onQueryDraftChange(
                        target.checked
                          ? addQueryToken(props.queryDraft, token)
                          : removeQueryToken(props.queryDraft, token),
                      );
                    }}
                  />
                  <span>${value}</span>
                </label>
              `;
            })}
          </div>
        </div>
      </details>
    `;
  };
  const exportStamp = formatIsoDate(new Date());

  return html`
    <style>${usageStylesString}</style>

    <section class="usage-page-header">
      <div class="usage-page-title">Usage</div>
      <div class="usage-page-subtitle">See where tokens go, when sessions spike, and what drives cost.</div>
    </section>

    <section class="card usage-header ${props.headerPinned ? "pinned" : ""}">
      <div class="usage-header-row">
        <div class="usage-header-title">
          <div class="card-title" style="margin: 0;">Filters</div>
          ${
            props.loading
              ? html`
                  <span class="usage-refresh-indicator">Loading</span>
                `
              : nothing
          }
          ${
            isEmpty
              ? html`
                  <span class="usage-query-hint">Select a date range and click Refresh to load usage.</span>
                `
              : nothing
          }
        </div>
        <div class="usage-header-metrics">
          ${
            displayTotals
              ? html`
                <span class="usage-metric-badge">
                  <strong>${formatTokens(displayTotals.totalTokens)}</strong> tokens
                </span>
                <span class="usage-metric-badge">
                  <strong>${formatCost(displayTotals.totalCost)}</strong> cost
                </span>
                <span class="usage-metric-badge">
                  <strong>${displaySessionCount}</strong>
                  session${displaySessionCount !== 1 ? "s" : ""}
                </span>
              `
              : nothing
          }
          <button
            class="usage-pin-btn ${props.headerPinned ? "active" : ""}"
            title=${props.headerPinned ? "Unpin filters" : "Pin filters"}
            @click=${props.onToggleHeaderPinned}
          >
            ${props.headerPinned ? "Pinned" : "Pin"}
          </button>
          <details
            class="usage-export-menu"
            @toggle=${(e: Event) => {
              const el = e.currentTarget as HTMLDetailsElement;
              if (!el.open) {
                return;
              }
              const onClick = (ev: MouseEvent) => {
                const path = ev.composedPath();
                if (!path.includes(el)) {
                  el.open = false;
                  window.removeEventListener("click", onClick, true);
                }
              };
              window.addEventListener("click", onClick, true);
            }}
          >
            <summary class="usage-export-button">Export ▾</summary>
            <div class="usage-export-popover">
              <div class="usage-export-list">
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-sessions-${exportStamp}.csv`,
                      buildSessionsCsv(filteredSessions),
                      "text/csv",
                    )}
                  ?disabled=${filteredSessions.length === 0}
                >
                  Sessions CSV
                </button>
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-daily-${exportStamp}.csv`,
                      buildDailyCsv(filteredDaily),
                      "text/csv",
                    )}
                  ?disabled=${filteredDaily.length === 0}
                >
                  Daily CSV
                </button>
                <button
                  class="usage-export-item"
                  @click=${() =>
                    downloadTextFile(
                      `openclaw-usage-${exportStamp}.json`,
                      JSON.stringify(
                        {
                          totals: displayTotals,
                          sessions: filteredSessions,
                          daily: filteredDaily,
                          aggregates: activeAggregates,
                        },
                        null,
                        2,
                      ),
                      "application/json",
                    )}
                  ?disabled=${filteredSessions.length === 0 && filteredDaily.length === 0}
                >
                  JSON
                </button>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="usage-header-row">
        <div class="usage-controls">
          ${renderFilterChips(
            props.selectedDays,
            props.selectedHours,
            props.selectedSessions,
            props.sessions,
            props.onClearDays,
            props.onClearHours,
            props.onClearSessions,
            props.onClearFilters,
          )}
          <div class="usage-presets">
            ${datePresets.map(
              (preset) => html`
                <button class="btn btn-sm" @click=${() => applyPreset(preset.days)}>
                  ${preset.label}
                </button>
              `,
            )}
          </div>
          <input
            type="date"
            .value=${props.startDate}
            title="Start Date"
            @change=${(e: Event) => props.onStartDateChange((e.target as HTMLInputElement).value)}
          />
          <span style="color: var(--text-muted);">to</span>
          <input
            type="date"
            .value=${props.endDate}
            title="End Date"
            @change=${(e: Event) => props.onEndDateChange((e.target as HTMLInputElement).value)}
          />
          <select
            title="Time zone"
            .value=${props.timeZone}
            @change=${(e: Event) =>
              props.onTimeZoneChange((e.target as HTMLSelectElement).value as "local" | "utc")}
          >
            <option value="local">Local</option>
            <option value="utc">UTC</option>
          </select>
          <div class="chart-toggle">
            <button
              class="toggle-btn ${isTokenMode ? "active" : ""}"
              @click=${() => props.onChartModeChange("tokens")}
            >
              Tokens
            </button>
            <button
              class="toggle-btn ${!isTokenMode ? "active" : ""}"
              @click=${() => props.onChartModeChange("cost")}
            >
              Cost
            </button>
          </div>
          <button
            class="btn btn-sm usage-action-btn usage-primary-btn"
            @click=${props.onRefresh}
            ?disabled=${props.loading}
          >
            Refresh
          </button>
        </div>
        
      </div>

      <div style="margin-top: 12px;">
          <div class="usage-query-bar">
          <input
            class="usage-query-input"
            type="text"
            .value=${props.queryDraft}
            placeholder="Filter sessions (e.g. key:agent:main:cron* model:gpt-4o has:errors minTokens:2000)"
            @input=${(e: Event) => props.onQueryDraftChange((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.onApplyQuery();
              }
            }}
          />
          <div class="usage-query-actions">
            <button
              class="btn btn-sm usage-action-btn usage-secondary-btn"
              @click=${props.onApplyQuery}
              ?disabled=${props.loading || (!hasDraftQuery && !hasQuery)}
            >
              Filter (client-side)
            </button>
            ${
              hasDraftQuery || hasQuery
                ? html`<button class="btn btn-sm usage-action-btn usage-secondary-btn" @click=${props.onClearQuery}>Clear</button>`
                : nothing
            }
            <span class="usage-query-hint">
              ${
                hasQuery
                  ? `${filteredSessions.length} of ${totalSessions} sessions match`
                  : `${totalSessions} sessions in range`
              }
            </span>
          </div>
        </div>
        <div class="usage-filter-row">
          ${renderFilterSelect("agent", "Agent", agentOptions)}
          ${renderFilterSelect("channel", "Channel", channelOptions)}
          ${renderFilterSelect("provider", "Provider", providerOptions)}
          ${renderFilterSelect("model", "Model", modelOptions)}
          ${renderFilterSelect("tool", "Tool", toolOptions)}
          <span class="usage-query-hint">
            Tip: use filters or click bars to filter days.
          </span>
        </div>
        ${
          queryTerms.length > 0
            ? html`
                <div class="usage-query-chips">
                  ${queryTerms.map((term) => {
                    const label = term.raw;
                    return html`
                      <span class="usage-query-chip">
                        ${label}
                        <button
                          title="Remove filter"
                          @click=${() =>
                            props.onQueryDraftChange(removeQueryToken(props.queryDraft, label))}
                        >
                          ×
                        </button>
                      </span>
                    `;
                  })}
                </div>
              `
            : nothing
        }
        ${
          querySuggestions.length > 0
            ? html`
                <div class="usage-query-suggestions">
                  ${querySuggestions.map(
                    (suggestion) => html`
                      <button
                        class="usage-query-suggestion"
                        @click=${() =>
                          props.onQueryDraftChange(
                            applySuggestionToQuery(props.queryDraft, suggestion.value),
                          )}
                      >
                        ${suggestion.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${
          queryWarnings.length > 0
            ? html`
                <div class="callout warning" style="margin-top: 8px;">
                  ${queryWarnings.join(" · ")}
                </div>
              `
            : nothing
        }
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${
        props.sessionsLimitReached
          ? html`
              <div class="callout warning" style="margin-top: 12px">
                Showing first 1,000 sessions. Narrow date range for complete results.
              </div>
            `
          : nothing
      }
    </section>

    ${renderUsageInsights(
      displayTotals,
      activeAggregates,
      insightStats,
      hasMissingCost,
      buildPeakErrorHours(aggregateSessions, props.timeZone),
      displaySessionCount,
      totalSessions,
    )}

    ${renderUsageMosaic(aggregateSessions, props.timeZone, props.selectedHours, props.onSelectHour)}

    <!-- Two-column layout: Daily+Breakdown on left, Sessions on right -->
    <div class="usage-grid">
      <div class="usage-grid-left">
        <div class="card usage-left-card">
          ${renderDailyChartCompact(
            filteredDaily,
            props.selectedDays,
            props.chartMode,
            props.dailyChartMode,
            props.onDailyChartModeChange,
            props.onSelectDay,
          )}
          ${displayTotals ? renderCostBreakdownCompact(displayTotals, props.chartMode) : nothing}
        </div>
      </div>
      <div class="usage-grid-right">
        ${renderSessionsCard(
          filteredSessions,
          props.selectedSessions,
          props.selectedDays,
          isTokenMode,
          props.sessionSort,
          props.sessionSortDir,
          props.recentSessions,
          props.sessionsTab,
          props.onSelectSession,
          props.onSessionSortChange,
          props.onSessionSortDirChange,
          props.onSessionsTabChange,
          props.visibleColumns,
          totalSessions,
          props.onClearSessions,
        )}
      </div>
    </div>

    <!-- Session Detail Panel (when selected) or Empty State -->
    ${
      primarySelectedEntry
        ? renderSessionDetailPanel(
            primarySelectedEntry,
            props.timeSeries,
            props.timeSeriesLoading,
            props.timeSeriesMode,
            props.onTimeSeriesModeChange,
            props.timeSeriesBreakdownMode,
            props.onTimeSeriesBreakdownChange,
            props.startDate,
            props.endDate,
            props.selectedDays,
            props.sessionLogs,
            props.sessionLogsLoading,
            props.sessionLogsExpanded,
            props.onToggleSessionLogsExpanded,
            {
              roles: props.logFilterRoles,
              tools: props.logFilterTools,
              hasTools: props.logFilterHasTools,
              query: props.logFilterQuery,
            },
            props.onLogFilterRolesChange,
            props.onLogFilterToolsChange,
            props.onLogFilterHasToolsChange,
            props.onLogFilterQueryChange,
            props.onLogFilterClear,
            props.contextExpanded,
            props.onToggleContextExpanded,
            props.onClearSessions,
          )
        : renderEmptyDetailState()
    }
  `;
}

// Exposed for Playwright/Vitest browser unit tests.
