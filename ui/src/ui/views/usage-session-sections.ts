import { html, svg, nothing } from "lit";
import type { TimeSeriesPoint, UsageSessionEntry } from "./usageTypes.ts";
import { charsToTokens, formatCost, formatTokens } from "./usage-shared.ts";

function pct(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return (part / total) * 100;
}

export function renderTimeSeriesCompact(
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

export function renderContextPanel(
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

export { renderSessionLogsCompact } from "./usage-session-logs.ts";
