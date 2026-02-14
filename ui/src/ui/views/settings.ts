import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import type { UiSettings } from "../storage.ts";
import { renderThemeToggle } from "../app-render.helpers.ts";
import { icons } from "../icons.ts";
import { TTS_MOOD_PRESETS } from "./voice-bar.ts";

function platformCommandKey(): string {
  if (typeof navigator === "undefined") {
    return "Ctrl";
  }
  const platform = navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Cmd" : "Ctrl";
}

function statusLabel(value: boolean | null | undefined, opts?: { on?: string; off?: string }) {
  if (value == null) {
    return "Unknown";
  }
  return value ? (opts?.on ?? "On") : (opts?.off ?? "Off");
}

function statusPill(value: boolean | null | undefined, opts?: { on?: string; off?: string }) {
  const label = statusLabel(value, opts);
  const ok = value === true;
  const warn = value === false;
  return html`
    <span class="pill ${ok ? "" : warn ? "danger" : ""}">
      <span class="statusDot ${ok ? "ok" : ""}"></span>
      <span>${label}</span>
    </span>
  `;
}

export function renderSettings(state: AppViewState) {
  const cmdKey = platformCommandKey();
  const runtimeDisabledReason = !state.connected
    ? "Connect to the gateway to use runtime toggles."
    : null;
  const focusDisabled = state.onboarding;
  const thinkingDisabled = state.onboarding;

  const splitRatio = (() => {
    const raw = typeof state.settings.splitRatio === "number" ? state.settings.splitRatio : 0.6;
    return Math.max(0.4, Math.min(0.7, raw));
  })();
  const splitPercent = Math.round(splitRatio * 100);

  const resetLayout = () => {
    const next: UiSettings = {
      ...state.settings,
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      ttsVoice: "",
      ttsInstruct: "Speak warmly and calmly",
      ttsLanguage: "",
    };
    state.applySettings(next);
    // Keep the live split ratio state in sync with the saved setting.
    (state as unknown as { splitRatio?: number }).splitRatio = next.splitRatio;
  };

  return html`
    <section class="grid grid-cols-2">
      <section class="card">
        <div class="card-title">Control UI</div>
        <div class="card-sub">Preferences stored in this browser.</div>

        <div class="stack" style="margin-top: 16px;">
          <div class="row" style="justify-content: space-between; gap: 16px; flex-wrap: wrap;">
            <div>
              <div class="muted">Theme</div>
              <div class="muted" style="margin-top: 4px;">
                Current: <span class="mono">${state.themeResolved}</span>
              </div>
            </div>
            ${renderThemeToggle(state)}
          </div>

          <div class="form-grid" style="margin-top: 6px;">
            <label class="field checkbox">
              <input
                type="checkbox"
                .checked=${state.settings.chatShowThinking}
                ?disabled=${thinkingDisabled}
                @change=${(e: Event) => {
                  if (thinkingDisabled) {
                    return;
                  }
                  const next = (e.target as HTMLInputElement).checked;
                  state.applySettings({ ...state.settings, chatShowThinking: next });
                }}
              />
              <span title=${thinkingDisabled ? "Disabled during onboarding" : ""}>Show thinking</span>
            </label>

            <label class="field checkbox">
              <input
                type="checkbox"
                .checked=${state.settings.chatFocusMode}
                ?disabled=${focusDisabled}
                @change=${(e: Event) => {
                  if (focusDisabled) {
                    return;
                  }
                  const next = (e.target as HTMLInputElement).checked;
                  state.applySettings({ ...state.settings, chatFocusMode: next });
                }}
              />
              <span title=${focusDisabled ? "Disabled during onboarding" : ""}>Chat focus mode</span>
            </label>

            <label class="field checkbox">
              <input
                type="checkbox"
                .checked=${state.settings.navCollapsed}
                @change=${(e: Event) => {
                  const next = (e.target as HTMLInputElement).checked;
                  state.applySettings({ ...state.settings, navCollapsed: next });
                }}
              />
              <span>Collapse sidebar</span>
            </label>
          </div>

          <div class="stack" style="margin-top: 8px;">
            <label class="field">
              <span>Tool sidebar split</span>
              <input
                type="range"
                min="0.4"
                max="0.7"
                step="0.01"
                .value=${String(splitRatio)}
                @input=${(e: Event) => {
                  const next = Number((e.target as HTMLInputElement).value);
                  (
                    state as unknown as { handleSplitRatioChange?: (ratio: number) => void }
                  ).handleSplitRatioChange?.(next);
                }}
              />
              <div class="muted">Sidebar width: <span class="mono">${splitPercent}%</span></div>
            </label>
          </div>

          <div class="row" style="flex-wrap: wrap; margin-top: 2px;">
            <button class="btn" @click=${() => state.openCommandPalette()}>
              ${icons.search} Search (${cmdKey}+K)
            </button>
            <button class="btn" @click=${resetLayout}>Reset layout</button>
          </div>

          ${
            state.onboarding
              ? html`
                  <div class="callout warn" style="margin-top: 6px">
                    Onboarding mode is active, some UI toggles are disabled.
                  </div>
                `
              : nothing
          }
        </div>
      </section>

      <section class="card">
        <div class="card-title">Gateway Runtime</div>
        <div class="card-sub">Quick controls that affect the running gateway.</div>

        ${runtimeDisabledReason ? html`<div class="callout" style="margin-top: 14px;">${runtimeDisabledReason}</div>` : nothing}

        <div class="list" style="margin-top: 16px;">
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">Memory Search</div>
              <div class="list-sub">Patches <span class="mono">agents.defaults.memorySearch.enabled</span> in config.</div>
            </div>
            <div class="list-meta">
              ${statusPill(state.memorySearchEnabled)}
              <button
                class="btn ${state.memorySearchEnabled === false ? "primary" : ""}"
                ?disabled=${!state.connected || state.memorySearchBusy}
                @click=${() => state.handleMemorySearchToggle()}
              >
                ${
                  state.memorySearchBusy
                    ? "Working..."
                    : state.memorySearchEnabled === false
                      ? "Enable"
                      : "Disable"
                }
              </button>
            </div>
          </div>

          <div class="list-item">
            <div class="list-main">
              <div class="list-title">NVIDIA Router</div>
              <div class="list-sub">Controls request routing and failover for DGX-first setups.</div>
            </div>
            <div class="list-meta">
              ${statusPill(state.nvidiaRouterEnabled, { on: state.nvidiaRouterHealthy === false ? "On (degraded)" : "On", off: "Off" })}
              <button
                class="btn"
                ?disabled=${!state.connected || state.nvidiaRouterBusy}
                @click=${() => state.handleNvidiaRouterToggle()}
              >
                ${
                  state.nvidiaRouterBusy
                    ? "Working..."
                    : state.nvidiaRouterEnabled === false
                      ? "Enable"
                      : "Disable"
                }
              </button>
            </div>
          </div>

          <div class="list-item">
            <div class="list-main">
              <div class="list-title">Voice Bar</div>
              <div class="list-sub">Show the voice conversation widget in the corner.</div>
            </div>
            <div class="list-meta">
              ${statusPill(state.voiceBarVisible, { on: "Visible", off: "Hidden" })}
              <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
                <button class="btn" ?disabled=${!state.connected} @click=${() => state.toggleVoiceBar()}>
                  ${state.voiceBarVisible ? "Hide" : "Show"}
                </button>
                ${
                  state.voiceBarVisible
                    ? html`
                      <button class="btn" ?disabled=${!state.connected} @click=${() => state.toggleVoiceBarExpanded()}>
                        ${state.voiceBarExpanded ? "Collapse" : "Expand"}
                      </button>
                    `
                    : nothing
                }
              </div>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top: 14px; gap: 8px; flex-wrap: wrap;">
          <button
            class="btn"
            ?disabled=${!state.connected || state.doctorRunning}
            @click=${() => state.handleDoctorRun()}
            title="Run non-interactive doctor checks on the gateway host"
          >
            ${state.doctorRunning ? "Doctor running…" : "Run Doctor"}
          </button>
          <button
            class="btn"
            ?disabled=${!state.connected || state.doctorRunning}
            @click=${() => state.handleDoctorRun({ deep: true })}
            title="Run a deeper doctor pass (may take longer)"
          >
            Doctor (deep)
          </button>
          <button
            class="btn danger"
            ?disabled=${!state.connected || state.gatewayRestartBusy}
            @click=${() => {
              const ok = confirm(
                "Restart the gateway now? Connected clients will briefly disconnect.",
              );
              if (!ok) {
                return;
              }
              void state.handleGatewayRestart();
            }}
            title="Restart the gateway process"
          >
            ${state.gatewayRestartBusy ? "Restarting…" : "Restart Gateway"}
          </button>
        </div>

        ${
          state.gatewayRestartError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${state.gatewayRestartError}
            </div>`
            : nothing
        }

        ${
          state.doctorError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${state.doctorError}
            </div>`
            : nothing
        }

        ${
          state.doctorResult
            ? html`<div class="callout" style="margin-top: 12px;">
              <div class="muted">
                Doctor: <span class="mono">${state.doctorResult.ok ? "ok" : "failed"}</span>
                <span class="muted"> · </span>
                <span class="mono">${Math.round(state.doctorResult.durationMs)}ms</span>
                ${
                  state.doctorResult.exitCode != null
                    ? html`<span class="muted"> · </span>
                      exit <span class="mono">${state.doctorResult.exitCode}</span>`
                    : nothing
                }
              </div>
              <pre class="mono" style="margin-top: 10px; white-space: pre-wrap; max-height: 260px; overflow: auto;">${[
                state.doctorResult.stdout,
                state.doctorResult.stderr ? `\n[stderr]\n${state.doctorResult.stderr}` : "",
              ]
                .filter(Boolean)
                .join("\n")}</pre>
            </div>`
            : nothing
        }
      </section>
    </section>

    ${renderSparkTtsSettings(state)}

    <section class="grid grid-cols-2" style="margin-top: 18px;">
      <section class="card">
        <div class="card-title">Workflows</div>
        <div class="card-sub">Jump to the right page for deeper control.</div>
        <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
          <button class="btn" @click=${() => state.setTab("sessions")}>Sessions</button>
          <button class="btn" @click=${() => state.setTab("nodes")}>Nodes + Exec approvals</button>
          <button class="btn" @click=${() => state.setTab("skills")}>Skills</button>
          <button class="btn" @click=${() => state.setTab("channels")}>Channels</button>
          <button class="btn" @click=${() => state.setTab("config")}>Config editor</button>
          <button class="btn" @click=${() => state.setTab("logs")}>Logs</button>
          <button class="btn" @click=${() => state.setTab("debug")}>Debug</button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">Help</div>
        <div class="card-sub">Docs and quick reminders.</div>
        <div class="stack" style="margin-top: 14px;">
          <div class="callout">
            Command palette: <span class="mono">${cmdKey}+K</span>
          </div>
          <div class="callout">
            Session reset: send <span class="mono">/new</span> in Chat.
          </div>
          <div class="callout">
            Tokenized URL: <span class="mono">openclaw dashboard --no-open</span>
          </div>
          <div class="row" style="flex-wrap: wrap;">
            <a class="btn" href="https://docs.openclaw.ai/web/dashboard" target="_blank" rel="noreferrer">
              Docs: Dashboard
            </a>
            <a class="btn" href="https://docs.openclaw.ai/web/control-ui" target="_blank" rel="noreferrer">
              Docs: Control UI
            </a>
          </div>
        </div>
      </section>
    </section>
  `;
}

/**
 * Spark TTS settings card: voice, mood, language.
 * Triggers a one-time voice list fetch when connected and the list is empty.
 */
function renderSparkTtsSettings(state: AppViewState) {
  // Trigger voice list fetch on first render when connected
  if (state.connected && (state.sparkVoices?.length ?? 0) === 0) {
    void (state as unknown as { loadSparkVoices?: () => Promise<void> }).loadSparkVoices?.();
  }

  const voices: { id: string; name: string; description?: string }[] = state.sparkVoices ?? [];
  const currentVoice = state.settings.ttsVoice ?? "";
  const currentInstruct = state.settings.ttsInstruct ?? "";

  return html`
    <section class="grid grid-cols-2" style="margin-top: 18px;">
      <section class="card">
        <div class="card-title">Spark TTS</div>
        <div class="card-sub">Default voice and mood for Spark TTS (per-message Speak and voice bar).</div>

        <div class="stack" style="margin-top: 16px;">
          <label class="field">
            <span>Voice</span>
            <select
              ?disabled=${!state.connected}
              .value=${currentVoice}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                state.applySettings({ ...state.settings, ttsVoice: v });
              }}
              title="Speaker identity (who speaks). Default is Ryan."
            >
              <option value="">Default (Ryan)</option>
              ${voices.map(
                (v) =>
                  html`<option value=${v.name} title=${v.description ?? ""}>${v.name}${v.description ? ` \u2014 ${v.description}` : ""}</option>`,
              )}
            </select>
          </label>

          <label class="field">
            <span>Mood</span>
            <select
              .value=${currentInstruct}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                state.applySettings({ ...state.settings, ttsInstruct: v });
              }}
              title="How it's said (tone, style). Passed as instruct to the TTS model."
            >
              ${TTS_MOOD_PRESETS.map((p) => html`<option value=${p.value}>${p.label}</option>`)}
            </select>
            <div class="muted" style="margin-top: 4px;">
              Current: <span class="mono">${currentInstruct || "(none)"}</span>
            </div>
          </label>
        </div>
      </section>
    </section>
  `;
}
