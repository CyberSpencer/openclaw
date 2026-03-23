import { html, nothing } from "lit";
import type { ProviderUsageSnapshot } from "../../../../src/infra/provider-usage.types.ts";
import { formatAgo, formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { formatNextRun } from "../presenter.ts";
import type { UiSettings } from "../storage.ts";
import { renderAnthropicProviderStatus } from "./anthropic-provider-status.ts";
import { renderOverviewAttention } from "./overview-attention.ts";
import { renderOverviewCards } from "./overview-cards.ts";
import { renderOverviewEventLog } from "./overview-event-log.ts";
import {
  resolveAuthHintKind,
  shouldShowInsecureContextHint,
  shouldShowPairingHint,
} from "./overview-hints.ts";
import { renderOverviewLogTail } from "./overview-log-tail.ts";

type ControlUiBuildMeta = {
  uiIndexMtimeMs?: number | null;
  gatewayBuild?: {
    version?: string | null;
    commit?: string | null;
    builtAt?: string | null;
  } | null;
};

function readControlUiBuildMeta(): ControlUiBuildMeta | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = (window as unknown as { __OPENCLAW_CONTROL_UI_META__?: unknown })
    .__OPENCLAW_CONTROL_UI_META__;
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as ControlUiBuildMeta;
}

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastErrorCode: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  cronStatus: import("../types.ts").CronStatus | null;
  lastChannelsRefresh: number | null;
  usageResult: import("../types.ts").SessionsUsageResult | null;
  sessionsResult: import("../types.ts").SessionsListResult | null;
  skillsReport: import("../types.ts").SkillStatusReport | null;
  cronJobs: import("../types.ts").CronJob[];
  eventLog: import("../app-events.ts").EventLogEntry[];
  overviewLogLines: string[];
  systemStatusLoading: boolean;
  systemStatusError: string | null;
  routerStatus: import("../types.js").RouterStatus | null;
  sparkStatus: import("../types.js").SparkStatus | null;
  anthropicSnapshot?: ProviderUsageSnapshot | null;
  orchBoards: import("../orchestrator-store.ts").OrchestrationBoard[];
  orchSelectedBoardId: string;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onRefreshLogs: () => void;
  onRouterSetEnabled: (enabled: boolean) => void;
  onNavigate: (tab: string) => void;
};

function deriveAttentionItems(props: OverviewProps): import("../types.ts").AttentionItem[] {
  const items: import("../types.ts").AttentionItem[] = [];
  if (!props.connected && props.lastError) {
    items.push({
      severity: "error",
      icon: "radio",
      title: "Gateway disconnected",
      description: props.lastError,
    });
  }
  if (props.connected && props.routerStatus?.enabled === true && !props.routerStatus?.healthy) {
    items.push({
      severity: "warning",
      icon: "link",
      title: "Router unhealthy",
      description: "NVIDIA router is enabled but the latest health check did not pass.",
    });
  }
  if (props.connected && props.sparkStatus?.enabled === true && !props.sparkStatus?.active) {
    items.push({
      severity: "error",
      icon: "server",
      title: "DGX Spark degraded",
      description: "DGX Spark is enabled but the current service set is not fully healthy.",
    });
  }
  if (props.cronEnabled === false) {
    items.push({
      severity: "info",
      icon: "loader",
      title: "Cron scheduler disabled",
      description: "Recurring jobs exist in the gateway, but the scheduler is currently off.",
    });
  }
  return items;
}

function deriveSparkIssues(spark: import("../types.js").SparkStatus | null | undefined): string[] {
  if (!spark?.services || typeof spark.services !== "object") {
    return [];
  }
  return Object.entries(spark.services)
    .flatMap(([name, raw]) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const service = raw as { healthy?: unknown; error?: unknown };
      if (service.healthy === true) {
        return [];
      }
      const detail =
        typeof service.error === "string" && service.error.trim()
          ? ` (${service.error.trim()})`
          : "";
      return [`${name}${detail}`];
    })
    .slice(0, 4);
}

function deriveCommandCenterModel(props: OverviewProps): {
  status: "healthy" | "degraded" | "offline";
  runningCount: number;
  reviewCount: number;
  failedCount: number;
  reasons: string[];
  boardTitle: string | null;
} {
  const board =
    props.orchBoards.find((entry) => entry.id === props.orchSelectedBoardId) ??
    props.orchBoards[0] ??
    null;
  const cards = board?.cards ?? [];
  const runningCount = cards.filter(
    (card) =>
      card.laneId === "running" ||
      card.run?.status === "accepted" ||
      card.run?.status === "running",
  ).length;
  const reviewCount = cards.filter((card) => card.laneId === "review").length;
  const failedCount = cards.filter(
    (card) => card.laneId === "failed" || card.run?.status === "error",
  ).length;

  const reasons: string[] = [];
  if (!props.connected) {
    reasons.push("Gateway disconnected");
  }
  if (props.routerStatus?.enabled === true && !props.routerStatus.healthy) {
    reasons.push("Router health check failing");
  }
  if (props.sparkStatus?.enabled === true && !props.sparkStatus.active) {
    reasons.push("DGX Spark degraded");
  }
  reasons.push(...deriveSparkIssues(props.sparkStatus));
  if (failedCount > 0) {
    reasons.push(`${failedCount} orchestrator card${failedCount === 1 ? "" : "s"} failed`);
  }

  const status = !props.connected ? "offline" : reasons.length > 0 ? "degraded" : "healthy";

  return {
    status,
    runningCount,
    reviewCount,
    failedCount,
    reasons: Array.from(new Set(reasons)).slice(0, 5),
    boardTitle: board?.title ?? null,
  };
}

export function renderOverview(props: OverviewProps) {
  const buildMeta = readControlUiBuildMeta();
  const uiIndexMtimeMs =
    typeof buildMeta?.uiIndexMtimeMs === "number" ? buildMeta.uiIndexMtimeMs : null;
  const uiIndexTitle = uiIndexMtimeMs ? new Date(uiIndexMtimeMs).toLocaleString() : "";
  const uiIndexValue = uiIndexMtimeMs ? formatRelativeTimestamp(uiIndexMtimeMs) : "n/a";
  const gatewayBuild = buildMeta?.gatewayBuild ?? null;
  const gatewayVersion =
    gatewayBuild && typeof gatewayBuild.version === "string" ? gatewayBuild.version : null;
  const gatewayCommit =
    gatewayBuild && typeof gatewayBuild.commit === "string" ? gatewayBuild.commit : null;
  const gatewayCommitShort = gatewayCommit ? gatewayCommit.slice(0, 8) : null;

  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number } }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs ? `${snapshot.policy.tickIntervalMs}ms` : "n/a";
  const authHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const kind = resolveAuthHintKind({
      connected: props.connected,
      lastError: props.lastError,
      lastErrorCode: props.lastErrorCode,
      hasToken: Boolean(props.settings.token.trim()),
      hasPassword: Boolean(props.password.trim()),
    });
    if (kind == null) {
      return null;
    }
    if (kind === "required") {
      return html`
        <div class="muted" style="margin-top: 8px">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">openclaw dashboard --no-open</span>, or update the token, then click Connect.
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();
  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext) {
      return null;
    }
    if (!shouldShowInsecureContextHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or open
        <span class="mono">http://127.0.0.1:32555</span> on the gateway host.
        <div style="margin-top: 6px">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();
  const pairingHint = (() => {
    if (!shouldShowPairingHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        This device needs pairing approval from the gateway host.
        <div style="margin-top: 6px">
          <span class="mono">openclaw devices list</span><br />
          <span class="mono">openclaw devices approve &lt;requestId&gt;</span>
        </div>
      </div>
    `;
  })();

  const router = props.routerStatus;
  const routerEnabled = typeof router?.enabled === "boolean" ? router.enabled : null;
  const routerHealthy = Boolean(router?.enabled && router?.healthy);
  const routerCheckedAt = typeof router?.checkedAt === "number" ? router.checkedAt : null;

  const spark = props.sparkStatus;
  const sparkEnabled = typeof spark?.enabled === "boolean" ? spark.enabled : null;
  const sparkActive = Boolean(spark?.enabled && spark?.active);
  const sparkCheckedAt = typeof spark?.checkedAt === "number" ? spark.checkedAt : null;
  const commandCenter = deriveCommandCenterModel(props);
  const commandCenterLabel =
    commandCenter.status === "healthy"
      ? "Healthy"
      : commandCenter.status === "degraded"
        ? "Degraded"
        : "Offline";

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Gateway Access</div>
        <div class="card-sub">Where the dashboard connects and how it authenticates.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:32555"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder="OPENCLAW_GATEWAY_TOKEN"
            />
          </label>
          <label class="field">
            <span>Password (not stored)</span>
            <input
              type="password"
              .value=${props.password}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onPasswordChange(v);
              }}
              placeholder="system or shared password"
            />
          </label>
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>Connect</button>
          <button class="btn" @click=${() => props.onRefresh()}>Refresh</button>
          <span class="muted">Click Connect to apply connection changes.</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Snapshot</div>
        <div class="card-sub">Latest gateway handshake information.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Status</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected ? "Connected" : "Disconnected"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Tick Interval</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Last Channels Refresh</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatAgo(props.lastChannelsRefresh) : "n/a"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">UI build</div>
            <div class="stat-value" title=${uiIndexTitle}>${uiIndexValue}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Gateway build</div>
            <div class="stat-value">${gatewayVersion ?? "n/a"}</div>
            ${
              gatewayCommitShort
                ? html`<div class="muted mono" style="margin-top: 6px; font-size: 11px;">
                    ${gatewayCommitShort}
                  </div>`
                : nothing
            }
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${pairingHint ?? ""}
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
            : html`
                <div class="callout" style="margin-top: 14px">
                  Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.
                </div>
              `
        }
      </div>
    </section>

    ${renderOverviewCards({
      usageResult: props.usageResult,
      sessionsResult: props.sessionsResult,
      skillsReport: props.skillsReport,
      cronJobs: props.cronJobs,
      cronStatus: props.cronStatus,
      presenceCount: props.presenceCount,
      onNavigate: props.onNavigate,
    })}

    ${renderOverviewAttention({ items: deriveAttentionItems(props) })}

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="muted">Presence beacons in the last 5 minutes.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${props.sessionsCount ?? "n/a"}</div>
        <div class="muted">Recent session keys tracked by the gateway.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Cron</div>
        <div class="stat-value">
          ${props.cronEnabled == null ? "n/a" : props.cronEnabled ? "Enabled" : "Disabled"}
        </div>
        <div class="muted">Next wake ${formatNextRun(props.cronNext)}</div>
      </div>
    </section>

    ${
      props.systemStatusError
        ? html`<div class="callout danger" style="margin-top: 18px;">${props.systemStatusError}</div>`
        : nothing
    }

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card">
        <div class="card-title">LLM Router</div>
        <div class="card-sub">NVIDIA router + local fallback routing status.</div>
        <div class="pill" style="margin-top: 14px; width: fit-content;">
          <span
            class="statusDot ${routerHealthy ? "ok" : ""}"
            style=${
              !props.connected || routerEnabled !== true
                ? "background: var(--border-strong); box-shadow: none;"
                : ""
            }
          ></span>
          <span>Status</span>
          <span class="mono">
            ${
              !props.connected
                ? "n/a"
                : routerEnabled === false
                  ? "Disabled"
                  : routerEnabled === true
                    ? routerHealthy
                      ? "Healthy"
                      : "Unhealthy"
                    : "n/a"
            }
          </span>
        </div>
        <div class="muted" style="margin-top: 10px;">
          Last check: ${routerCheckedAt ? formatRelativeTimestamp(routerCheckedAt) : "n/a"}
        </div>
        <div class="muted mono" style="margin-top: 6px; word-break: break-all;">
          ${router?.url ?? ""}
        </div>
        <div class="row" style="margin-top: 14px;">
          <button
            class="btn ${routerEnabled ? "danger" : "primary"}"
            ?disabled=${!props.connected || props.systemStatusLoading || routerEnabled == null}
            @click=${() => {
              if (routerEnabled == null) {
                return;
              }
              const next = !routerEnabled;
              if (
                routerEnabled &&
                !confirm(
                  "Disable the NVIDIA router?\n\nFallback routing will still work, but cloud requests may run without the router.",
                )
              ) {
                return;
              }
              props.onRouterSetEnabled(next);
            }}
            title=${routerEnabled ? "Disable NVIDIA router" : "Enable NVIDIA router"}
          >
            ${routerEnabled ? "Disable" : "Enable"}
          </button>
          <button
            class="btn"
            ?disabled=${props.systemStatusLoading}
            @click=${() => props.onRefresh()}
            title="Refresh overview"
          >
            Refresh
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Spark (DGX)</div>
        <div class="card-sub">Reachability for router, Ollama, and Qdrant on your Spark host.</div>
        <div class="pill" style="margin-top: 14px; width: fit-content;">
          <span
            class="statusDot ${sparkActive ? "ok" : ""}"
            style=${!props.connected || sparkEnabled !== true ? "background: var(--border-strong); box-shadow: none;" : ""}
          ></span>
          <span>Status</span>
          <span class="mono">
            ${
              !props.connected
                ? "n/a"
                : sparkEnabled === false
                  ? "Disabled"
                  : sparkEnabled === true
                    ? sparkActive
                      ? "Active"
                      : "Down"
                    : "n/a"
            }
          </span>
        </div>
        <div class="muted" style="margin-top: 10px;">
          Host: <span class="mono">${spark?.host ?? "n/a"}</span>
        </div>
        <div class="muted" style="margin-top: 6px;">
          Last check: ${sparkCheckedAt ? formatRelativeTimestamp(sparkCheckedAt) : "n/a"}
        </div>
        ${
          spark?.services && typeof spark.services === "object"
            ? html`<div style="margin-top: 10px; display: grid; gap: 6px;">
                ${Object.entries(spark.services).map(([name, svc]) => {
                  const healthy = (() => {
                    if (!svc || typeof svc !== "object") {
                      return false;
                    }
                    return Boolean((svc as { healthy?: unknown }).healthy);
                  })();
                  return html`<div class="pill" style="width: fit-content;">
                    <span class="statusDot ${healthy ? "ok" : ""}"></span>
                    <span class="mono">${name}</span>
                    <span class="mono">${healthy ? "ok" : "down"}</span>
                  </div>`;
                })}
              </div>`
            : nothing
        }
      </div>

      ${renderAnthropicProviderStatus({
        snapshot: props.anthropicSnapshot ?? null,
        loading: false,
      })}

    </section>

    <section class="grid grid-cols-2" style="margin-top: 18px;">
      <div class="card">
        <div class="card-title">Command Center</div>
        <div class="card-sub">Cross-signal operator summary for orchestration, routing, and DGX health.</div>
        <div class="pill" style="margin-top: 14px; width: fit-content;">
          <span class="statusDot ${commandCenter.status === "healthy" ? "ok" : ""}"></span>
          <span>Status</span>
          <span class="mono">${commandCenterLabel}</span>
        </div>
        <div class="stat-grid" style="margin-top: 14px;">
          <div class="stat">
            <div class="stat-label">Running</div>
            <div class="stat-value">${commandCenter.runningCount}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Review</div>
            <div class="stat-value">${commandCenter.reviewCount}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Failed</div>
            <div class="stat-value">${commandCenter.failedCount}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Board</div>
            <div class="stat-value">${commandCenter.boardTitle ?? "n/a"}</div>
          </div>
        </div>
        ${
          commandCenter.reasons.length
            ? html`<div style="margin-top: 14px; display: grid; gap: 6px;">
                ${commandCenter.reasons.map(
                  (reason) => html`<div class="pill" style="width: fit-content;">
                    <span class="mono">${reason}</span>
                  </div>`,
                )}
              </div>`
            : html`
                <div class="muted" style="margin-top: 14px">
                  Router, DGX, and orchestrator signals are currently quiet.
                </div>
              `
        }
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onNavigate("orchestrator")}>Orchestrator</button>
          <button class="btn" @click=${() => props.onNavigate("dgx")}>DGX</button>
          <button class="btn" @click=${() => props.onNavigate("debug")}>Debug</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Notes</div>
        <div class="card-sub">Quick reminders for remote control setups.</div>
        <div class="note-grid" style="margin-top: 14px;">
          <div>
            <div class="note-title">Tailscale serve</div>
            <div class="muted">
              Prefer serve mode to keep the gateway on loopback with tailnet auth.
            </div>
          </div>
          <div>
            <div class="note-title">Session hygiene</div>
            <div class="muted">Use /new or sessions.patch to reset context.</div>
          </div>
          <div>
            <div class="note-title">Cron reminders</div>
            <div class="muted">Use isolated sessions for recurring runs.</div>
          </div>
        </div>
      </div>
    </section>

    ${renderOverviewEventLog({ events: props.eventLog })}

    ${renderOverviewLogTail({
      lines: props.overviewLogLines,
      onRefreshLogs: props.onRefreshLogs,
    })}
  `;
}
