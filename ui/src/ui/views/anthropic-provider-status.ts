import { html, nothing, type TemplateResult } from "lit";
import type { ProviderUsageSnapshot } from "../../../../src/infra/provider-usage.types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnthropicProviderStatusProps = {
  snapshot: ProviderUsageSnapshot | null;
  loading: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Format a reset countdown from a future timestamp.
 * Returns strings like "resets in 3h 15m", "resets in 45m", or "resetting soon".
 */
export function formatResetCountdown(resetAt: number, now: number): string {
  const diffMs = resetAt - now;
  if (diffMs <= 0) {
    return "resetting soon";
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }
  return `resets in ${minutes}m`;
}

/**
 * Returns a CSS modifier class based on usage percentage.
 * '' for normal, 'warn' for >80%, 'critical' for >95%.
 */
export function resolveWindowBarClass(usedPercent: number): string {
  if (usedPercent > 95) {
    return "critical";
  }
  if (usedPercent > 80) {
    return "warn";
  }
  return "";
}

/**
 * Returns true if the note text indicates a suppression/warn state.
 */
export function resolveNoteIsWarn(note: string): boolean {
  return note.includes("paused") || note.includes("rate_limit");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderAnthropicProviderStatus(
  props: AnthropicProviderStatusProps,
): TemplateResult | typeof nothing {
  const { snapshot, loading } = props;
  if (loading || !snapshot) {
    return nothing;
  }

  const hasFallback = (snapshot.notes ?? []).some((n) => n.includes("paused"));
  const now = Date.now();

  return html`
    <div class="card" style="margin-top: 18px;">
      <div class="card-title">Anthropic Usage</div>
      <div class="card-sub">
        ${snapshot.displayName}${snapshot.plan ? html` &mdash; ${snapshot.plan}` : nothing}
      </div>

      ${
        snapshot.windows.length > 0
          ? html`
            <div style="margin-top: 14px; display: grid; gap: 10px;">
              ${snapshot.windows.map((win) => {
                const barClass = resolveWindowBarClass(win.usedPercent);
                const clamped = Math.min(100, Math.max(0, win.usedPercent));
                return html`
                  <div>
                    <div
                      style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;"
                    >
                      <span class="mono" style="font-size: 0.8em;">${win.label}</span>
                      <span
                        class="muted"
                        style="font-size: 0.75em; ${barClass ? "color: var(--warn, #e0a030);" : ""}"
                      >
                        ${win.usedPercent.toFixed(0)}%
                        ${
                          win.resetAt
                            ? html`&nbsp;&middot;&nbsp;${formatResetCountdown(win.resetAt, now)}`
                            : nothing
                        }
                      </span>
                    </div>
                    <div
                      style="height: 6px; border-radius: 3px; background: var(--border-subtle, #333); overflow: hidden;"
                    >
                      <div
                        style="height: 100%; width: ${clamped}%; border-radius: 3px; background: ${barClass === "critical" ? "var(--error, #e05050)" : barClass === "warn" ? "var(--warn, #e0a030)" : "var(--accent, #4e8ef7)"}; transition: width 0.3s;"
                      ></div>
                    </div>
                  </div>
                `;
              })}
            </div>
          `
          : nothing
      }

      ${
        snapshot.notes && snapshot.notes.length > 0
          ? html`
            <div style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px;">
              ${snapshot.notes.map(
                (note) => html`
                  <span
                    class="pill ${resolveNoteIsWarn(note) ? "pill--warn" : ""}"
                    style="${resolveNoteIsWarn(note) ? "border-color: var(--warn, #e0a030); color: var(--warn, #e0a030);" : ""}"
                    title=${note}
                  >
                    ${note}
                  </span>
                `,
              )}
            </div>
          `
          : nothing
      }

      ${
        hasFallback
          ? html`
              <div
                class="pill"
                style="margin-top: 10px; width: fit-content; border-color: var(--border-subtle, #333)"
              >
                <span style="font-size: 0.8em; color: var(--muted, #888)">Active fallback:</span>
                <span class="mono" style="font-size: 0.8em">Nemotron-3-nano</span>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
