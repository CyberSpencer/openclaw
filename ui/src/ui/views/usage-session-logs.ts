import { html, nothing } from "lit";
import type { SessionLogEntry, SessionLogRole } from "./usageTypes.ts";
import { parseToolSummary } from "../usage-helpers.ts";
import { formatTokens } from "./usage-shared.ts";

export function renderSessionLogsCompact(
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
