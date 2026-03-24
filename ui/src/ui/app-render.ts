import { html, nothing } from "lit";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { refreshChatAvatar } from "./app-chat.ts";
import {
  renderChatControls,
  renderChatSessionSelect,
  renderTab,
  renderThemeToggle,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { loadAgentFiles, loadAgentFileContent, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentity, loadAgentIdentities } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import { loadAgents, loadToolsCatalog } from "./controllers/agents.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadChatThreads } from "./controllers/chat-threads.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config.ts";
import {
  addCronJob,
  cancelCronEdit,
  getVisibleCronJobs,
  hasCronFormErrors,
  loadCronRuns,
  loadMoreCronJobs,
  loadMoreCronRuns,
  normalizeCronFormState,
  reloadCronJobs,
  removeCronJob,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
} from "./controllers/cron.ts";
import { loadDebug, callDebugMethod } from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import {
  deleteSession,
  deleteSessionsAndRefresh,
  loadSessions,
  patchSession,
} from "./controllers/sessions.ts";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import { loadSubagentMonitor } from "./controllers/subagent-monitor.ts";
import { loadSessionLogs, loadSessionTimeSeries, loadUsage } from "./controllers/usage.ts";
import { icons } from "./icons.ts";
import { TAB_GROUPS, subtitleForTab, titleForTab } from "./navigation.ts";
import { resolveConfiguredCronModelSuggestions } from "./views/agents-utils.ts";
import { renderAgents } from "./views/agents.ts";
import { renderChannels } from "./views/channels.ts";
import { renderChatThreadsNav } from "./views/chat-threads-nav.ts";
import { renderChat } from "./views/chat.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { renderConfig } from "./views/config.ts";
import { renderCron } from "./views/cron.ts";
import { renderDebug } from "./views/debug.ts";
import { renderDgx } from "./views/dgx.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderInstances } from "./views/instances.ts";
import { renderLoginGate } from "./views/login-gate.ts";
import { renderLogs } from "./views/logs.ts";
import { renderNodes } from "./views/nodes.ts";
import { renderOrchestrator } from "./views/orchestrator.ts";
import { renderOverview } from "./views/overview.ts";
import { renderSessions } from "./views/sessions.ts";
import { renderSettings } from "./views/settings.ts";
import { renderSkills } from "./views/skills.ts";
import { renderUsage } from "./views/usage.ts";
import { renderVoiceBar } from "./views/voice-bar.ts";
import "./components/dashboard-header.ts";

const CRON_THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const COMMUNICATION_SECTION_KEYS = ["channels", "messages", "broadcast", "talk", "audio"] as const;
const APPEARANCE_SECTION_KEYS = ["ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = [
  "commands",
  "hooks",
  "bindings",
  "cron",
  "approvals",
  "plugins",
] as const;
const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
] as const;
const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;
const CRON_TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

const DISMISSED_UPDATE_BANNER_KEY = "openclaw.control.dismissed-update-banner.v1";

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(DISMISSED_UPDATE_BANNER_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    window.localStorage.setItem(DISMISSED_UPDATE_BANNER_KEY, JSON.stringify(payload));
  } catch {
    /* ignore storage failures */
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeSuggestionValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return identity?.avatarUrl;
}

/**
 * Classify the active model provider into a source category for the topbar indicator.
 */
function classifyModelSource(provider: string | null): {
  label: string;
  cssClass: string;
} | null {
  if (!provider) {
    return null;
  }
  const p = provider.toLowerCase();
  if (
    p.startsWith("openai") ||
    p.startsWith("anthropic") ||
    p.startsWith("google") ||
    p.startsWith("deepseek") ||
    p.startsWith("mistral") ||
    p.startsWith("xai") ||
    p.startsWith("groq") ||
    p.startsWith("together") ||
    p.startsWith("fireworks") ||
    p.startsWith("github-copilot") ||
    p.includes("codex")
  ) {
    return { label: "Cloud", cssClass: "model-cloud" };
  }
  if (p.includes("spark") || p.includes("dgx")) {
    return { label: "Spark", cssClass: "model-spark" };
  }
  if (p === "ollama" || p.includes("local") || p.includes("lmstudio")) {
    return { label: "Local", cssClass: "model-local" };
  }
  return { label: provider, cssClass: "model-other" };
}

function renderModelPill(state: AppViewState) {
  // Prefer active stream selection (real-time routing info)
  const selection = state.chatModelSelection;
  let provider = selection?.provider ?? null;
  let modelId = selection?.model ?? null;

  // Fall back to the session's configured model when not actively streaming
  if (!provider && !modelId && state.tab === "chat") {
    const row = state.sessionsResult?.sessions?.find((s) => s.key === state.sessionKey);
    if (row?.modelProvider || row?.model) {
      provider = row.modelProvider ?? null;
      modelId = row.model ?? null;
    }
  }

  if (!provider && !modelId) {
    return nothing;
  }

  const source = classifyModelSource(provider);
  if (!source) {
    return nothing;
  }

  const shortModel = modelId
    ? (modelId
        .replace(/:latest$/, "")
        .split("/")
        .pop() ?? modelId)
    : "";
  const title = provider && modelId ? `${provider}/${modelId}` : (provider ?? modelId ?? "");

  // Use a cloud icon for remote providers, server icon for local/DGX
  const modelIcon =
    source.cssClass === "model-spark" || source.cssClass === "model-local"
      ? icons.server
      : icons.cloud;

  return html`
    <div class="pill pill--model ${source.cssClass}" title="${title}">
      <span class="pill-icon">${modelIcon}</span>
      ${shortModel ? html`<span class="mono">${shortModel}</span>` : nothing}
    </div>
  `;
}

export function renderApp(state: AppViewState) {
  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;
  const topbarLogoSrc = `${state.basePath}/favicon.svg`;
  const sparkEnabled = state.sparkStatus?.enabled;
  const sparkKnown = Boolean(state.sparkStatus);
  const sparkHost = typeof state.sparkStatus?.host === "string" ? state.sparkStatus.host : null;
  const sparkOverall =
    typeof state.sparkStatus?.overall === "string" ? state.sparkStatus.overall : null;
  const sparkLabel = state.sparkBusy
    ? "..."
    : !sparkKnown
      ? "..."
      : sparkEnabled === false
        ? "Off"
        : sparkOverall === "degraded"
          ? "Degraded"
          : "";
  const sparkDotClass =
    !sparkKnown || sparkEnabled === false
      ? "neutral"
      : sparkOverall === "healthy"
        ? "ok"
        : sparkOverall === "degraded"
          ? "warn"
          : sparkOverall === "down"
            ? "err"
            : "";
  const sparkTitle = !sparkKnown
    ? "DGX status unavailable"
    : sparkEnabled === false
      ? "DGX disabled"
      : `DGX ${sparkOverall ?? "unknown"}${sparkHost ? ` (${sparkHost})` : ""}`;
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const resolvedAgentId =
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const systemStatusLoading = state.nvidiaRouterBusy || state.sparkBusy;
  const routerStatus: import("./types.js").RouterStatus | null =
    state.nvidiaRouterEnabled == null && state.nvidiaRouterHealthy == null
      ? null
      : {
          enabled: state.nvidiaRouterEnabled !== false,
          healthy: state.nvidiaRouterEnabled === false ? false : state.nvidiaRouterHealthy === true,
          url: "",
          checkedAt: Date.now(),
          error: state.nvidiaRouterError ?? undefined,
        };
  const sparkStatus: import("./types.js").SparkStatus | null = state.sparkStatus
    ? {
        enabled: state.sparkStatus.enabled !== false,
        active: state.sparkStatus.active === true,
        source: state.sparkStatus.source,
        host: typeof state.sparkStatus.host === "string" ? state.sparkStatus.host : null,
        checkedAt:
          typeof state.sparkStatus.checkedAt === "number"
            ? state.sparkStatus.checkedAt
            : Date.now(),
        voiceAvailable: state.sparkStatus.voiceAvailable,
        overall: state.sparkStatus.overall,
        counts: state.sparkStatus.counts,
        services: state.sparkStatus.services,
        gpu: state.sparkStatus.gpu,
        containers: state.sparkStatus.containers,
      }
    : null;

  if (!state.connected) {
    return html`
      ${renderLoginGate(state)}
      ${renderGatewayUrlConfirmation(state)}
    `;
  }

  const visibleCronJobs = getVisibleCronJobs(state);
  const cronAgentSuggestions = Array.from(
    new Set(
      [
        ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
        ...state.cronJobs
          .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
          .filter(Boolean),
      ].filter(Boolean),
    ),
  ).toSorted((a, b) => a.localeCompare(b));
  const cronModelSuggestionsMerged = Array.from(
    new Set(
      [
        ...state.cronModelSuggestions,
        ...resolveConfiguredCronModelSuggestions(configValue),
        ...state.cronJobs
          .map((job) => {
            if (job.payload.kind !== "agentTurn" || typeof job.payload.model !== "string") {
              return "";
            }
            return job.payload.model.trim();
          })
          .filter(Boolean),
      ].filter(Boolean),
    ),
  ).toSorted((a, b) => a.localeCompare(b));
  const selectedDeliveryChannel =
    state.cronForm.deliveryChannel && state.cronForm.deliveryChannel.trim()
      ? state.cronForm.deliveryChannel.trim()
      : "last";
  const jobToSuggestions = state.cronJobs
    .map((job) => normalizeSuggestionValue(job.delivery?.to))
    .filter(Boolean);
  const accountToSuggestions = (
    selectedDeliveryChannel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[selectedDeliveryChannel] ?? [])
  )
    .flatMap((account) => [
      normalizeSuggestionValue(account.accountId),
      normalizeSuggestionValue(account.name),
    ])
    .filter(Boolean);
  const rawDeliveryToSuggestions = uniquePreserveOrder([
    ...jobToSuggestions,
    ...accountToSuggestions,
  ]);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? rawDeliveryToSuggestions.filter((value) => isHttpUrl(value))
      : rawDeliveryToSuggestions;

  return html`
    <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}">
      <a class="skip-link" href="#main-content">Skip to content</a>
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle"
            @click=${() =>
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">${icons.menu}</span>
          </button>
          <div class="brand">
            <div class="brand-logo">
              <img src=${topbarLogoSrc} alt="OpenClaw" />
            </div>
            <div class="brand-text">
              <div class="brand-title">OPENCLAW</div>
              <div class="brand-sub">Gateway Dashboard</div>
            </div>
          </div>
        </div>
        <div class="topbar-status">
          ${renderModelPill(state)}
          <div class="pill">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
          <button
            class="pill topbar-action-btn topbar-action-btn--status"
            ?disabled=${!state.connected || state.memorySearchBusy}
            @click=${() => state.handleMemorySearchToggle()}
            title="${(() => {
              const base =
                state.memorySearchEnabled === false
                  ? "Enable memory search"
                  : "Disable memory search";
              return state.memoryStoreLabel ? `${base} (${state.memoryStoreLabel})` : base;
            })()}"
            aria-label="${state.memorySearchEnabled === false ? "Enable memory search" : "Disable memory search"}"
          >
            <span class="statusDot ${state.memorySearchEnabled === false ? "" : "ok"}"></span>
            <span>Memory</span>
            <span class="mono">
              ${
                state.memorySearchBusy
                  ? "..."
                  : state.memorySearchEnabled === false
                    ? "Off"
                    : state.memoryStoreLabel
                      ? state.memoryStoreLabel
                      : "On"
              }
            </span>
          </button>
          <button
            class="pill topbar-action-btn topbar-action-btn--status"
            ?disabled=${!state.connected || state.sparkBusy}
            @click=${() => state.setTab("dgx")}
            title=${sparkTitle}
            aria-label="DGX Spark status"
          >
            <span class="statusDot ${sparkDotClass}"></span>
            <span>DGX</span>
            <span class="mono">${sparkLabel}</span>
          </button>
          ${renderThemeToggle(state)}
        </div>
      </header>
      <aside class="nav ${state.settings.navCollapsed ? "nav--collapsed" : ""}">
        ${
          state.tab === "chat"
            ? renderChatThreadsNav({
                connected: state.connected,
                onboarding: state.onboarding,
                showThinking: state.settings.chatShowThinking,
                focusMode: state.settings.chatFocusMode,
                loading: state.chatThreadsLoading,
                error: state.chatThreadsError,
                sessions: state.chatThreadsResult,
                activeSessionKey: state.sessionKey,
                query: state.chatThreadsQuery,
                showSubagents: state.chatThreadsShowSubagents,
                onNewChat: () => state.handleChatNewThread(),
                onSelectChat: (key) => state.openChatSession(key),
                onQueryChange: (next) => state.handleChatThreadsQueryChange(next),
                onToggleSubagents: () =>
                  (state.chatThreadsShowSubagents = !state.chatThreadsShowSubagents),
                onRenameChat: (key) => state.handleChatThreadRename(key),
                onDeleteChat: (key) => state.handleChatThreadDelete(key),
                onRefresh: () => loadChatThreads(state, { search: state.chatThreadsQuery }),
                onToggleThinking: () => {
                  if (state.onboarding) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                },
                onToggleFocusMode: () => {
                  if (state.onboarding) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                },
              })
            : nothing
        }
        ${TAB_GROUPS.map((group) => {
          const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
          const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
          return html`
            <div class="nav-group ${isGroupCollapsed && !hasActiveTab ? "nav-group--collapsed" : ""}">
              <button
                class="nav-label"
                @click=${() => {
                  const next = { ...state.settings.navGroupsCollapsed };
                  next[group.label] = !isGroupCollapsed;
                  state.applySettings({
                    ...state.settings,
                    navGroupsCollapsed: next,
                  });
                }}
                aria-expanded=${!isGroupCollapsed}
              >
                <span class="nav-label__text">${group.label}</span>
                <span class="nav-label__chevron">${isGroupCollapsed ? "+" : "−"}</span>
              </button>
              <div class="nav-group__items">
                ${group.tabs.map((tab) => renderTab(state, tab))}
              </div>
            </div>
          `;
        })}
        <div class="nav-group nav-group--links">
          <div class="nav-label nav-label--static">
            <span class="nav-label__text">Resources</span>
          </div>
          <div class="nav-group__items">
            <a
              class="nav-item nav-item--external"
              href="https://docs.openclaw.ai"
              target="_blank"
              rel="noreferrer"
              title="Docs (opens in new tab)"
            >
              <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
              <span class="nav-item__text">Docs</span>
            </a>
          </div>
        </div>
      </aside>
      <main id="main-content" class="content ${isChat ? "content--chat" : ""}" tabindex="-1">
        ${
          state.updateAvailable &&
          state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
          !isUpdateBannerDismissed(state.updateAvailable)
            ? html`<div class="update-banner callout danger" role="alert">
                <strong>Update available:</strong> v${state.updateAvailable.latestVersion}
                (running v${state.updateAvailable.currentVersion}).
                <button
                  class="btn btn--sm update-banner__btn"
                  ?disabled=${state.updateRunning || !state.connected}
                  @click=${() => runUpdate(state)}
                >
                  ${state.updateRunning ? "Updating…" : "Update & restart"}
                </button>
                <button
                  class="btn btn--sm update-banner__btn"
                  title="Dismiss"
                  aria-label="Dismiss update banner"
                  @click=${() => {
                    dismissUpdateBanner(state.updateAvailable);
                    state.updateAvailable = null;
                  }}
                >
                  ${icons.x}
                </button>
              </div>`
            : nothing
        }
        <section class="content-header">
          <div>
            ${
              isChat
                ? renderChatSessionSelect(state)
                : state.tab === "usage"
                  ? nothing
                  : html`<div class="page-title">${titleForTab(state.tab)}</div>`
            }
            ${isChat || state.tab === "usage" ? nothing : html`<div class="page-sub">${subtitleForTab(state.tab)}</div>`}
          </div>
          <div class="page-meta">
            ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
            ${isChat ? renderChatControls(state) : nothing}
          </div>
        </section>

        ${state.tab === "orchestrator" ? renderOrchestrator(state) : nothing}

        ${
          state.tab === "overview"
            ? renderOverview({
                connected: state.connected,
                hello: state.hello,
                settings: state.settings,
                password: state.password,
                lastError: state.lastError,
                lastErrorCode: state.lastErrorCode,
                presenceCount,
                sessionsCount,
                cronEnabled: state.cronStatus?.enabled ?? null,
                cronNext,
                cronStatus: state.cronStatus,
                lastChannelsRefresh: state.channelsLastSuccess,
                usageResult: state.usageResult,
                sessionsResult: state.sessionsResult,
                skillsReport: state.skillsReport,
                cronJobs: state.cronJobs,
                eventLog: state.eventLog,
                overviewLogLines: state.logsEntries.map(
                  (entry) => entry.raw ?? entry.message ?? "",
                ),
                systemStatusLoading,
                systemStatusError: state.lastError,
                routerStatus,
                sparkStatus,
                anthropicSnapshot: state.anthropicUsageSnapshot,
                orchBoards: state.orchBoards,
                orchSelectedBoardId: state.orchSelectedBoardId,
                onSettingsChange: (next) => state.applySettings(next),
                onPasswordChange: (next) => (state.password = next),
                onSessionKeyChange: (next) => {
                  state.sessionKey = next;
                  state.chatMessage = "";
                  state.resetToolStream();
                  state.applySettings({
                    ...state.settings,
                    sessionKey: next,
                    lastActiveSessionKey: next,
                  });
                  void state.loadAssistantIdentity();
                },
                onConnect: () => state.connect(),
                onRefresh: () => state.loadOverview(),
                onRefreshLogs: () => loadLogs(state, { reset: true }),
                onRouterSetEnabled: (enabled) => void state.handleNvidiaRouterToggle(enabled),
                onNavigate: (tab) => state.setTab(tab as import("./navigation.ts").Tab),
              })
            : nothing
        }

        ${
          state.tab === "dgx"
            ? renderDgx({
                connected: state.connected,
                sparkStatus,
                routingStatus: state.dgxRoutingStatus,
                onRefresh: () => state.refreshSparkStatus(),
              })
            : nothing
        }

        ${state.tab === "settings" ? renderSettings(state) : nothing}

        ${
          state.tab === "channels"
            ? renderChannels({
                connected: state.connected,
                loading: state.channelsLoading,
                snapshot: state.channelsSnapshot,
                lastError: state.channelsError,
                lastSuccessAt: state.channelsLastSuccess,
                whatsappMessage: state.whatsappLoginMessage,
                whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
                whatsappConnected: state.whatsappLoginConnected,
                whatsappBusy: state.whatsappBusy,
                configSchema: state.configSchema,
                configSchemaLoading: state.configSchemaLoading,
                configForm: state.configForm,
                configUiHints: state.configUiHints,
                configSaving: state.configSaving,
                configFormDirty: state.configFormDirty,
                nostrProfileFormState: state.nostrProfileFormState,
                nostrProfileAccountId: state.nostrProfileAccountId,
                onRefresh: (probe) => loadChannels(state, probe),
                onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
                onWhatsAppWait: () => state.handleWhatsAppWait(),
                onWhatsAppLogout: () => state.handleWhatsAppLogout(),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigSave: () => state.handleChannelConfigSave(),
                onConfigReload: () => state.handleChannelConfigReload(),
                onNostrProfileEdit: (accountId, profile) =>
                  state.handleNostrProfileEdit(accountId, profile),
                onNostrProfileCancel: () => state.handleNostrProfileCancel(),
                onNostrProfileFieldChange: (field, value) =>
                  state.handleNostrProfileFieldChange(field, value),
                onNostrProfileSave: () => state.handleNostrProfileSave(),
                onNostrProfileImport: () => state.handleNostrProfileImport(),
                onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
              })
            : nothing
        }

        ${
          state.tab === "instances"
            ? renderInstances({
                loading: state.presenceLoading,
                entries: state.presenceEntries,
                lastError: state.presenceError,
                statusMessage: state.presenceStatus,
                onRefresh: () => loadPresence(state),
              })
            : nothing
        }

        ${
          state.tab === "sessions"
            ? renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                basePath: state.basePath,
                searchQuery: state.sessionsSearchQuery,
                sortColumn: state.sessionsSortColumn,
                sortDir: state.sessionsSortDir,
                page: state.sessionsPage,
                pageSize: state.sessionsPageSize,
                selectedKeys: state.sessionsSelectedKeys,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                  state.sessionsPage = 0;
                  state.sessionsSelectedKeys = new Set();
                },
                onSearchChange: (query) => {
                  state.sessionsSearchQuery = query;
                  state.sessionsPage = 0;
                },
                onSortChange: (column, dir) => {
                  state.sessionsSortColumn = column;
                  state.sessionsSortDir = dir;
                  state.sessionsPage = 0;
                },
                onPageChange: (page) => {
                  state.sessionsPage = Math.max(0, page);
                },
                onPageSizeChange: (size) => {
                  state.sessionsPageSize = size;
                  state.sessionsPage = 0;
                },
                onRefresh: () => loadSessions(state),
                onPatch: (key, patch) => patchSession(state, key, patch),
                onToggleSelect: (key) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onSelectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const key of keys) {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const key of keys) {
                    next.delete(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectAll: () => {
                  state.sessionsSelectedKeys = new Set();
                },
                onDeleteSelected: async () => {
                  const deleted = await deleteSessionsAndRefresh(
                    state,
                    Array.from(state.sessionsSelectedKeys),
                  );
                  if (deleted.length > 0) {
                    const next = new Set(state.sessionsSelectedKeys);
                    for (const key of deleted) {
                      next.delete(key);
                    }
                    state.sessionsSelectedKeys = next;
                  }
                },
                onDelete: (key) => deleteSession(state, key),
              })
            : nothing
        }

        ${
          state.tab === "usage"
            ? renderUsage({
                loading: state.usageLoading,
                error: state.usageError,
                startDate: state.usageStartDate,
                endDate: state.usageEndDate,
                sessions: state.usageResult?.sessions ?? [],
                sessionsLimitReached: (state.usageResult?.sessions?.length ?? 0) >= 1000,
                totals: state.usageResult?.totals ?? null,
                aggregates: state.usageResult?.aggregates ?? null,
                costDaily: state.usageCostSummary?.daily ?? [],
                selectedSessions: state.usageSelectedSessions,
                selectedDays: state.usageSelectedDays,
                selectedHours: state.usageSelectedHours,
                chartMode: state.usageChartMode,
                dailyChartMode: state.usageDailyChartMode,
                timeSeriesMode: state.usageTimeSeriesMode,
                timeSeriesBreakdownMode: state.usageTimeSeriesBreakdownMode,
                timeSeries: state.usageTimeSeries,
                timeSeriesLoading: state.usageTimeSeriesLoading,
                timeSeriesCursorStart: state.usageTimeSeriesCursorStart,
                timeSeriesCursorEnd: state.usageTimeSeriesCursorEnd,
                sessionLogs: state.usageSessionLogs,
                sessionLogsLoading: state.usageSessionLogsLoading,
                sessionLogsExpanded: state.usageSessionLogsExpanded,
                logFilterRoles: state.usageLogFilterRoles,
                logFilterTools: state.usageLogFilterTools,
                logFilterHasTools: state.usageLogFilterHasTools,
                logFilterQuery: state.usageLogFilterQuery,
                query: state.usageQuery,
                queryDraft: state.usageQueryDraft,
                sessionSort: state.usageSessionSort,
                sessionSortDir: state.usageSessionSortDir,
                recentSessions: state.usageRecentSessions,
                sessionsTab: state.usageSessionsTab,
                visibleColumns:
                  state.usageVisibleColumns as import("./views/usage.ts").UsageColumnId[],
                timeZone: state.usageTimeZone,
                contextExpanded: state.usageContextExpanded,
                headerPinned: state.usageHeaderPinned,
                onStartDateChange: (date) => {
                  state.usageStartDate = date;
                  state.usageSelectedDays = [];
                  state.usageSelectedHours = [];
                  state.usageSelectedSessions = [];
                  void loadUsage(state);
                },
                onEndDateChange: (date) => {
                  state.usageEndDate = date;
                  state.usageSelectedDays = [];
                  state.usageSelectedHours = [];
                  state.usageSelectedSessions = [];
                  void loadUsage(state);
                },
                onRefresh: () => loadUsage(state),
                onTimeZoneChange: (zone) => {
                  state.usageTimeZone = zone;
                },
                onToggleContextExpanded: () => {
                  state.usageContextExpanded = !state.usageContextExpanded;
                },
                onToggleSessionLogsExpanded: () => {
                  state.usageSessionLogsExpanded = !state.usageSessionLogsExpanded;
                },
                onLogFilterRolesChange: (next) => {
                  state.usageLogFilterRoles = next;
                },
                onLogFilterToolsChange: (next) => {
                  state.usageLogFilterTools = next;
                },
                onLogFilterHasToolsChange: (next) => {
                  state.usageLogFilterHasTools = next;
                },
                onLogFilterQueryChange: (next) => {
                  state.usageLogFilterQuery = next;
                },
                onLogFilterClear: () => {
                  state.usageLogFilterRoles = [];
                  state.usageLogFilterTools = [];
                  state.usageLogFilterHasTools = false;
                  state.usageLogFilterQuery = "";
                },
                onToggleHeaderPinned: () => {
                  state.usageHeaderPinned = !state.usageHeaderPinned;
                },
                onSelectHour: (hour, shiftKey) => {
                  if (shiftKey && state.usageSelectedHours.length > 0) {
                    const allHours = Array.from({ length: 24 }, (_, i) => i);
                    const lastSelected =
                      state.usageSelectedHours[state.usageSelectedHours.length - 1];
                    const lastIdx = allHours.indexOf(lastSelected);
                    const thisIdx = allHours.indexOf(hour);
                    if (lastIdx !== -1 && thisIdx !== -1) {
                      const [start, end] =
                        lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
                      const range = allHours.slice(start, end + 1);
                      state.usageSelectedHours = [
                        ...new Set([...state.usageSelectedHours, ...range]),
                      ];
                    }
                  } else {
                    if (state.usageSelectedHours.includes(hour)) {
                      state.usageSelectedHours = state.usageSelectedHours.filter((h) => h !== hour);
                    } else {
                      state.usageSelectedHours = [...state.usageSelectedHours, hour];
                    }
                  }
                },
                onQueryDraftChange: (query) => {
                  state.usageQueryDraft = query;
                  if (state.usageQueryDebounceTimer) {
                    window.clearTimeout(state.usageQueryDebounceTimer);
                  }
                  state.usageQueryDebounceTimer = window.setTimeout(() => {
                    state.usageQuery = state.usageQueryDraft;
                    state.usageQueryDebounceTimer = null;
                  }, 250);
                },
                onApplyQuery: () => {
                  if (state.usageQueryDebounceTimer) {
                    window.clearTimeout(state.usageQueryDebounceTimer);
                    state.usageQueryDebounceTimer = null;
                  }
                  state.usageQuery = state.usageQueryDraft;
                },
                onClearQuery: () => {
                  if (state.usageQueryDebounceTimer) {
                    window.clearTimeout(state.usageQueryDebounceTimer);
                    state.usageQueryDebounceTimer = null;
                  }
                  state.usageQueryDraft = "";
                  state.usageQuery = "";
                },
                onSessionSortChange: (sort) => {
                  state.usageSessionSort = sort;
                },
                onSessionSortDirChange: (dir) => {
                  state.usageSessionSortDir = dir;
                },
                onSessionsTabChange: (tab) => {
                  state.usageSessionsTab = tab;
                },
                onToggleColumn: (column) => {
                  if (state.usageVisibleColumns.includes(column)) {
                    state.usageVisibleColumns = state.usageVisibleColumns.filter(
                      (entry) => entry !== column,
                    );
                  } else {
                    state.usageVisibleColumns = [...state.usageVisibleColumns, column];
                  }
                },
                onSelectSession: (key, shiftKey) => {
                  state.usageTimeSeries = null;
                  state.usageSessionLogs = null;
                  state.usageRecentSessions = [
                    key,
                    ...state.usageRecentSessions.filter((entry) => entry !== key),
                  ].slice(0, 8);

                  if (shiftKey && state.usageSelectedSessions.length > 0) {
                    // Shift-click: select range from last selected to this session
                    // Sort sessions same way as displayed (by tokens or cost descending)
                    const isTokenMode = state.usageChartMode === "tokens";
                    const sortedSessions = [...(state.usageResult?.sessions ?? [])].toSorted(
                      (a, b) => {
                        const valA = isTokenMode
                          ? (a.usage?.totalTokens ?? 0)
                          : (a.usage?.totalCost ?? 0);
                        const valB = isTokenMode
                          ? (b.usage?.totalTokens ?? 0)
                          : (b.usage?.totalCost ?? 0);
                        return valB - valA;
                      },
                    );
                    const allKeys = sortedSessions.map((s) => s.key);
                    const lastSelected =
                      state.usageSelectedSessions[state.usageSelectedSessions.length - 1];
                    const lastIdx = allKeys.indexOf(lastSelected);
                    const thisIdx = allKeys.indexOf(key);
                    if (lastIdx !== -1 && thisIdx !== -1) {
                      const [start, end] =
                        lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
                      const range = allKeys.slice(start, end + 1);
                      const newSelection = [...new Set([...state.usageSelectedSessions, ...range])];
                      state.usageSelectedSessions = newSelection;
                    }
                  } else {
                    // Regular click: focus a single session (so details always open).
                    // Click the focused session again to clear selection.
                    if (
                      state.usageSelectedSessions.length === 1 &&
                      state.usageSelectedSessions[0] === key
                    ) {
                      state.usageSelectedSessions = [];
                    } else {
                      state.usageSelectedSessions = [key];
                    }
                  }

                  // Load timeseries/logs only if exactly one session selected
                  if (state.usageSelectedSessions.length === 1) {
                    void loadSessionTimeSeries(state, state.usageSelectedSessions[0]);
                    void loadSessionLogs(state, state.usageSelectedSessions[0]);
                  }
                },
                onSelectDay: (day, shiftKey) => {
                  if (shiftKey && state.usageSelectedDays.length > 0) {
                    // Shift-click: select range from last selected to this day
                    const allDays = (state.usageCostSummary?.daily ?? []).map((d) => d.date);
                    const lastSelected =
                      state.usageSelectedDays[state.usageSelectedDays.length - 1];
                    const lastIdx = allDays.indexOf(lastSelected);
                    const thisIdx = allDays.indexOf(day);
                    if (lastIdx !== -1 && thisIdx !== -1) {
                      const [start, end] =
                        lastIdx < thisIdx ? [lastIdx, thisIdx] : [thisIdx, lastIdx];
                      const range = allDays.slice(start, end + 1);
                      // Merge with existing selection
                      const newSelection = [...new Set([...state.usageSelectedDays, ...range])];
                      state.usageSelectedDays = newSelection;
                    }
                  } else {
                    // Regular click: toggle single day
                    if (state.usageSelectedDays.includes(day)) {
                      state.usageSelectedDays = state.usageSelectedDays.filter((d) => d !== day);
                    } else {
                      state.usageSelectedDays = [day];
                    }
                  }
                },
                onChartModeChange: (mode) => {
                  state.usageChartMode = mode;
                },
                onDailyChartModeChange: (mode) => {
                  state.usageDailyChartMode = mode;
                },
                onTimeSeriesModeChange: (mode) => {
                  state.usageTimeSeriesMode = mode;
                },
                onTimeSeriesBreakdownChange: (mode) => {
                  state.usageTimeSeriesBreakdownMode = mode;
                },
                onTimeSeriesCursorRangeChange: (start, end) => {
                  state.usageTimeSeriesCursorStart = start;
                  state.usageTimeSeriesCursorEnd = end;
                },
                onClearDays: () => {
                  state.usageSelectedDays = [];
                },
                onClearHours: () => {
                  state.usageSelectedHours = [];
                },
                onClearSessions: () => {
                  state.usageSelectedSessions = [];
                  state.usageTimeSeries = null;
                  state.usageSessionLogs = null;
                },
                onClearFilters: () => {
                  state.usageSelectedDays = [];
                  state.usageSelectedHours = [];
                  state.usageSelectedSessions = [];
                  state.usageTimeSeries = null;
                  state.usageSessionLogs = null;
                },
              })
            : nothing
        }

        ${
          state.tab === "cron"
            ? renderCron({
                basePath: state.basePath,
                loading: state.cronLoading,
                jobsLoadingMore: state.cronJobsLoadingMore,
                status: state.cronStatus,
                jobs: visibleCronJobs,
                jobsTotal: state.cronJobsTotal,
                jobsHasMore: state.cronJobsHasMore,
                jobsQuery: state.cronJobsQuery,
                jobsEnabledFilter: state.cronJobsEnabledFilter,
                jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
                jobsLastStatusFilter: state.cronJobsLastStatusFilter,
                jobsSortBy: state.cronJobsSortBy,
                jobsSortDir: state.cronJobsSortDir,
                editingJobId: state.cronEditingJobId,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                fieldErrors: state.cronFieldErrors,
                canSubmit: !hasCronFormErrors(state.cronFieldErrors),
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                runsTotal: state.cronRunsTotal,
                runsHasMore: state.cronRunsHasMore,
                runsLoadingMore: state.cronRunsLoadingMore,
                runsScope: state.cronRunsScope,
                runsStatuses: state.cronRunsStatuses,
                runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
                runsStatusFilter: state.cronRunsStatusFilter,
                runsQuery: state.cronRunsQuery,
                runsSortDir: state.cronRunsSortDir,
                agentSuggestions: cronAgentSuggestions,
                modelSuggestions: cronModelSuggestionsMerged,
                thinkingSuggestions: CRON_THINKING_SUGGESTIONS,
                timezoneSuggestions: CRON_TIMEZONE_SUGGESTIONS,
                deliveryToSuggestions,
                onFormChange: (patch) => {
                  state.cronForm = normalizeCronFormState({ ...state.cronForm, ...patch });
                  state.cronFieldErrors = validateCronForm(state.cronForm);
                },
                onRefresh: () => state.loadCron(),
                onAdd: () => addCronJob(state),
                onEdit: (job) => startCronEdit(state, job),
                onClone: (job) => startCronClone(state, job),
                onCancelEdit: () => cancelCronEdit(state),
                onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
                onRun: (job) => void runCronJob(state, job),
                onRemove: (job) => removeCronJob(state, job),
                onLoadRuns: (jobId) => {
                  updateCronRunsFilter(state, { cronRunsScope: "job" });
                  void loadCronRuns(state, jobId);
                },
                onLoadMoreJobs: () => void loadMoreCronJobs(state),
                onJobsFiltersChange: async (patch) => {
                  updateCronJobsFilter(state, patch);
                  const shouldReload =
                    typeof patch.cronJobsQuery === "string" ||
                    Boolean(patch.cronJobsEnabledFilter) ||
                    Boolean(patch.cronJobsSortBy) ||
                    Boolean(patch.cronJobsSortDir);
                  if (shouldReload) {
                    await reloadCronJobs(state);
                  }
                },
                onJobsFiltersReset: async () => {
                  updateCronJobsFilter(state, {
                    cronJobsQuery: "",
                    cronJobsEnabledFilter: "all",
                    cronJobsScheduleKindFilter: "all",
                    cronJobsLastStatusFilter: "all",
                    cronJobsSortBy: "nextRunAtMs",
                    cronJobsSortDir: "asc",
                  });
                  await reloadCronJobs(state);
                },
                onLoadMoreRuns: () => void loadMoreCronRuns(state),
                onRunsFiltersChange: async (patch) => {
                  updateCronRunsFilter(state, patch);
                  if (state.cronRunsScope === "all") {
                    await loadCronRuns(state, null);
                    return;
                  }
                  await loadCronRuns(state, state.cronRunsJobId);
                },
                onToggleSchedulerEnabled: (enabled) =>
                  void state.handleCronSchedulerToggle(enabled),
              })
            : nothing
        }

        ${
          state.tab === "agents"
            ? renderAgents({
                loading: state.agentsLoading,
                error: state.agentsError,
                agentsList: state.agentsList,
                selectedAgentId: resolvedAgentId,
                activePanel: state.agentsPanel,
                configForm: configValue,
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                channelsLoading: state.channelsLoading,
                channelsError: state.channelsError,
                channelsSnapshot: state.channelsSnapshot,
                channelsLastSuccess: state.channelsLastSuccess,
                cronLoading: state.cronLoading,
                cronStatus: state.cronStatus,
                cronJobs: state.cronJobs,
                cronError: state.cronError,
                agentFilesLoading: state.agentFilesLoading,
                agentFilesError: state.agentFilesError,
                agentFilesList: state.agentFilesList,
                agentFileActive: state.agentFileActive,
                agentFileContents: state.agentFileContents,
                agentFileDrafts: state.agentFileDrafts,
                agentFileSaving: state.agentFileSaving,
                agentIdentityLoading: state.agentIdentityLoading,
                agentIdentityError: state.agentIdentityError,
                agentIdentityById: state.agentIdentityById,
                agentSkillsLoading: state.agentSkillsLoading,
                agentSkillsReport: state.agentSkillsReport,
                agentSkillsError: state.agentSkillsError,
                agentSkillsAgentId: state.agentSkillsAgentId,
                skillsFilter: state.skillsFilter,
                toolsCatalogLoading: state.toolsCatalogLoading,
                toolsCatalogError: state.toolsCatalogError,
                toolsCatalogResult: state.toolsCatalogResult,
                onRefresh: async () => {
                  await loadAgents(state);
                  void loadToolsCatalog(state);
                  const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
                  if (agentIds.length > 0) {
                    void loadAgentIdentities(state, agentIds);
                  }
                },
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                  state.agentFilesList = null;
                  state.agentFilesError = null;
                  state.agentFilesLoading = false;
                  state.agentFileActive = null;
                  state.agentFileContents = {};
                  state.agentFileDrafts = {};
                  state.agentSkillsReport = null;
                  state.agentSkillsError = null;
                  state.agentSkillsAgentId = null;
                  void loadAgentIdentity(state, agentId);
                  if (state.agentsPanel === "files") {
                    void loadAgentFiles(state, agentId);
                  }
                  if (state.agentsPanel === "skills") {
                    void loadAgentSkills(state, agentId);
                  }
                },
                onSelectPanel: (panel) => {
                  state.agentsPanel = panel;
                  if (panel === "files" && resolvedAgentId) {
                    if (state.agentFilesList?.agentId !== resolvedAgentId) {
                      state.agentFilesList = null;
                      state.agentFilesError = null;
                      state.agentFileActive = null;
                      state.agentFileContents = {};
                      state.agentFileDrafts = {};
                      void loadAgentFiles(state, resolvedAgentId);
                    }
                  }
                  if (panel === "skills") {
                    if (resolvedAgentId) {
                      void loadAgentSkills(state, resolvedAgentId);
                    }
                  }
                  if (panel === "channels") {
                    void loadChannels(state, false);
                  }
                  if (panel === "cron") {
                    void state.loadCron();
                  }
                },
                onLoadFiles: (agentId) => loadAgentFiles(state, agentId),
                onSelectFile: (name) => {
                  state.agentFileActive = name;
                  if (!resolvedAgentId) {
                    return;
                  }
                  void loadAgentFileContent(state, resolvedAgentId, name);
                },
                onFileDraftChange: (name, content) => {
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
                },
                onFileReset: (name) => {
                  const base = state.agentFileContents[name] ?? "";
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
                },
                onFileSave: (name) => {
                  if (!resolvedAgentId) {
                    return;
                  }
                  const content =
                    state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
                  void saveAgentFile(state, resolvedAgentId, name, content);
                },
                onToolsProfileChange: (agentId, profile, clearAllow) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "tools"];
                  if (profile) {
                    updateConfigFormValue(state, [...basePath, "profile"], profile);
                  } else {
                    removeConfigFormValue(state, [...basePath, "profile"]);
                  }
                  if (clearAllow) {
                    removeConfigFormValue(state, [...basePath, "allow"]);
                  }
                },
                onToolsOverridesChange: (agentId, alsoAllow, deny) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "tools"];
                  if (alsoAllow.length > 0) {
                    updateConfigFormValue(state, [...basePath, "alsoAllow"], alsoAllow);
                  } else {
                    removeConfigFormValue(state, [...basePath, "alsoAllow"]);
                  }
                  if (deny.length > 0) {
                    updateConfigFormValue(state, [...basePath, "deny"], deny);
                  } else {
                    removeConfigFormValue(state, [...basePath, "deny"]);
                  }
                },
                onConfigReload: () => loadConfig(state),
                onConfigSave: () => saveConfig(state),
                onChannelsRefresh: () => loadChannels(state, false),
                onCronRefresh: () => state.loadCron(),
                onSkillsFilterChange: (next) => (state.skillsFilter = next),
                onSkillsRefresh: () => {
                  if (resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                },
                onAgentSkillToggle: (agentId, skillName, enabled) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const entry = list[index] as { skills?: unknown };
                  const normalizedSkill = skillName.trim();
                  if (!normalizedSkill) {
                    return;
                  }
                  const allSkills =
                    state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ??
                    [];
                  const existing = Array.isArray(entry.skills)
                    ? entry.skills.map((name) => String(name).trim()).filter(Boolean)
                    : undefined;
                  const base = existing ?? allSkills;
                  const next = new Set(base);
                  if (enabled) {
                    next.add(normalizedSkill);
                  } else {
                    next.delete(normalizedSkill);
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
                },
                onAgentSkillsClear: (agentId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  removeConfigFormValue(state, ["agents", "list", index, "skills"]);
                },
                onAgentSkillsDisableAll: (agentId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
                },
                onModelChange: (agentId, modelId) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "model"];
                  if (!modelId) {
                    removeConfigFormValue(state, basePath);
                    return;
                  }
                  const entry = list[index] as { model?: unknown };
                  const existing = entry?.model;
                  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                    const fallbacks = (existing as { fallbacks?: unknown }).fallbacks;
                    const next = {
                      primary: modelId,
                      ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
                    };
                    updateConfigFormValue(state, basePath, next);
                  } else {
                    updateConfigFormValue(state, basePath, modelId);
                  }
                },
                onModelFallbacksChange: (agentId, fallbacks) => {
                  if (!configValue) {
                    return;
                  }
                  const list = (configValue as { agents?: { list?: unknown[] } }).agents?.list;
                  if (!Array.isArray(list)) {
                    return;
                  }
                  const index = list.findIndex(
                    (entry) =>
                      entry &&
                      typeof entry === "object" &&
                      "id" in entry &&
                      (entry as { id?: string }).id === agentId,
                  );
                  if (index < 0) {
                    return;
                  }
                  const basePath = ["agents", "list", index, "model"];
                  const entry = list[index] as { model?: unknown };
                  const normalized = fallbacks.map((name) => name.trim()).filter(Boolean);
                  const existing = entry.model;
                  const resolvePrimary = () => {
                    if (typeof existing === "string") {
                      return existing.trim() || null;
                    }
                    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                      const primary = (existing as { primary?: unknown }).primary;
                      if (typeof primary === "string") {
                        const trimmed = primary.trim();
                        return trimmed || null;
                      }
                    }
                    return null;
                  };
                  const primary = resolvePrimary();
                  if (normalized.length === 0) {
                    if (primary) {
                      updateConfigFormValue(state, basePath, primary);
                    } else {
                      removeConfigFormValue(state, basePath);
                    }
                    return;
                  }
                  const next = primary
                    ? { primary, fallbacks: normalized }
                    : { fallbacks: normalized };
                  updateConfigFormValue(state, basePath, next);
                },
              })
            : nothing
        }

        ${
          state.tab === "skills"
            ? renderSkills({
                loading: state.skillsLoading,
                report: state.skillsReport,
                error: state.skillsError,
                filter: state.skillsFilter,
                edits: state.skillEdits,
                messages: state.skillMessages,
                busyKey: state.skillsBusyKey,
                onFilterChange: (next) => (state.skillsFilter = next),
                onRefresh: () => loadSkills(state, { clearMessages: true }),
                onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onSaveKey: (key) => saveSkillApiKey(state, key),
                onInstall: (skillKey, name, installId) =>
                  installSkill(state, skillKey, name, installId),
              })
            : nothing
        }

        ${
          state.tab === "nodes"
            ? renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => loadNodes(state),
                onDevicesRefresh: () => loadDevices(state),
                onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId, role, scopes) =>
                  rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) => revokeDeviceToken(state, { deviceId, role }),
                onLoadConfig: () => loadConfig(state),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return loadExecApprovals(state, target);
                },
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePath, nodeId);
                  } else {
                    removeConfigFormValue(state, basePath);
                  }
                },
                onSaveBindings: () => saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return saveExecApprovals(state, target);
                },
              })
            : nothing
        }

        ${
          state.tab === "chat"
            ? html`
                ${
                  state.lastError
                    ? html`<div class="callout danger content-area-run-error" role="alert">Run failed: ${state.lastError}</div>`
                    : nothing
                }
                ${renderChat({
                  sessionKey: state.sessionKey,
                  onSessionKeyChange: (next) => {
                    state.openChatSession(next);
                  },
                  thinkingLevel: state.chatThinkingLevel,
                  showThinking,
                  loading: state.chatLoading,
                  sending: state.chatSending,
                  compactionStatus: state.compactionStatus,
                  assistantAvatarUrl: chatAvatarUrl,
                  messages: state.chatMessages,
                  toolMessages: state.chatToolMessages,
                  stream: state.chatStream,
                  streamStartedAt: state.chatStreamStartedAt,
                  modelSelection: state.chatModelSelection,
                  taskPlan: state.chatTaskPlan,
                  draft: state.chatMessage,
                  queue: state.chatQueue,
                  connected: state.connected,
                  canSend: state.connected,
                  disabledReason: chatDisabledReason,
                  error: state.lastError,
                  sessions: state.chatThreadsResult,
                  subagentMonitorLoading: state.subagentMonitorLoading,
                  subagentMonitorResult: state.subagentMonitorResult,
                  subagentMonitorError: state.subagentMonitorError,
                  onSubagentRefresh: () => loadSubagentMonitor(state, { quiet: false }),
                  focusMode: chatFocus,
                  onRefresh: () => {
                    state.resetToolStream();
                    return Promise.all([
                      loadChatHistory(state),
                      loadChatThreads(state, { search: state.chatThreadsQuery }),
                      refreshChatAvatar(state),
                    ]);
                  },
                  onToggleFocusMode: () => {
                    if (state.onboarding) {
                      return;
                    }
                    state.applySettings({
                      ...state.settings,
                      chatFocusMode: !state.settings.chatFocusMode,
                    });
                  },
                  onChatScroll: (event) => state.handleChatScroll(event),
                  onDraftChange: (next) => (state.chatMessage = next),
                  attachments: state.chatAttachments,
                  onAttachmentsChange: (next) => (state.chatAttachments = next),
                  onSend: () => state.handleSendChat(),
                  onQueue: () => state.handleSendChat(undefined, { forceQueue: true }),
                  canAbort: Boolean(state.chatRunId),
                  onAbort: () => void state.handleAbortChat(),
                  onQueueRemove: (id) => state.removeQueuedMessage(id),
                  onNewChat: () => state.handleChatNewThread(),
                  // Sidebar props for tool output viewing
                  sidebarOpen: state.sidebarOpen,
                  sidebarContent: state.sidebarContent,
                  sidebarError: state.sidebarError,
                  splitRatio: state.splitRatio,
                  onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
                  onCloseSidebar: () => state.handleCloseSidebar(),
                  onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                  orchestrationExpanded: state.orchestrationExpanded,
                  onOrchestrationExpandedChange: (expanded) =>
                    (state.orchestrationExpanded = expanded),
                  assistantName: state.assistantName,
                  assistantAvatar: state.assistantAvatar,
                  sparkVoiceAvailable: Boolean(
                    state.sparkStatus?.enabled && state.sparkStatus?.voiceAvailable === true,
                  ),
                  sparkMicRecording: state.sparkMicRecording ?? false,
                  voiceConversationActive: state.voiceState.conversationActive,
                  voiceMixedModeEnabled: state.settings.voiceMixedModeEnabled,
                  onMicClick: () => state.handleSparkMicClick?.(),
                  onSpeakClick: (text, messageKey) =>
                    void state.handleSpeakText?.(text, messageKey),
                  ttsSpeaking: state.ttsSpeaking ?? false,
                  ttsProgress: state.ttsProgress ?? null,
                  ttsSpeakingMessageKey: state.ttsSpeakingMessageKey ?? null,
                  onStopSpeaking: () => state.handleStopSpeaking?.(),
                  codexUsageNotes: state.codexUsageNotes,
                  anthropicUsageNotes: state.anthropicUsageNotes,
                  onSubagentStop: async (sessionKey: string) => {
                    if (!state.client) {
                      return;
                    }
                    await state.client.request("chat.abort", { sessionKey });
                  },
                })}
              `
            : nothing
        }

        ${
          state.tab === "config"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.configFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.configSearchQuery,
                activeSection: state.configActiveSection,
                activeSubsection: state.configActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.configFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.configSearchQuery = query),
                onSectionChange: (section) => {
                  state.configActiveSection = section;
                  state.configActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.configActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
              })
            : nothing
        }

        ${
          state.tab === "communications"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.communicationsFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.communicationsSearchQuery,
                activeSection: state.communicationsActiveSection,
                activeSubsection: state.communicationsActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.communicationsFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.communicationsSearchQuery = query),
                onSectionChange: (section) => {
                  state.communicationsActiveSection = section;
                  state.communicationsActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.communicationsActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
                navRootLabel: "Communications",
                includeSections: [...COMMUNICATION_SECTION_KEYS],
              })
            : nothing
        }

        ${
          state.tab === "appearance"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.appearanceFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.appearanceSearchQuery,
                activeSection: state.appearanceActiveSection,
                activeSubsection: state.appearanceActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.appearanceFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.appearanceSearchQuery = query),
                onSectionChange: (section) => {
                  state.appearanceActiveSection = section;
                  state.appearanceActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.appearanceActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
                navRootLabel: "Appearance",
                includeSections: [...APPEARANCE_SECTION_KEYS],
              })
            : nothing
        }

        ${
          state.tab === "automation"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.automationFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.automationSearchQuery,
                activeSection: state.automationActiveSection,
                activeSubsection: state.automationActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.automationFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.automationSearchQuery = query),
                onSectionChange: (section) => {
                  state.automationActiveSection = section;
                  state.automationActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.automationActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
                navRootLabel: "Automation",
                includeSections: [...AUTOMATION_SECTION_KEYS],
              })
            : nothing
        }

        ${
          state.tab === "infrastructure"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.infrastructureFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.infrastructureSearchQuery,
                activeSection: state.infrastructureActiveSection,
                activeSubsection: state.infrastructureActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.infrastructureFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.infrastructureSearchQuery = query),
                onSectionChange: (section) => {
                  state.infrastructureActiveSection = section;
                  state.infrastructureActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
                navRootLabel: "Infrastructure",
                includeSections: [...INFRASTRUCTURE_SECTION_KEYS],
              })
            : nothing
        }

        ${
          state.tab === "aiAgents"
            ? renderConfig({
                raw: state.configRaw,
                originalRaw: state.configRawOriginal,
                valid: state.configValid,
                issues: state.configIssues,
                loading: state.configLoading,
                saving: state.configSaving,
                applying: state.configApplying,
                updating: state.updateRunning,
                connected: state.connected,
                schema: state.configSchema,
                schemaLoading: state.configSchemaLoading,
                uiHints: state.configUiHints,
                formMode: state.aiAgentsFormMode,
                formValue: state.configForm,
                originalValue: state.configFormOriginal,
                searchQuery: state.aiAgentsSearchQuery,
                activeSection: state.aiAgentsActiveSection,
                activeSubsection: state.aiAgentsActiveSubsection,
                onRawChange: (next) => {
                  state.configRaw = next;
                },
                onFormModeChange: (mode) => (state.aiAgentsFormMode = mode),
                onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
                onSearchChange: (query) => (state.aiAgentsSearchQuery = query),
                onSectionChange: (section) => {
                  state.aiAgentsActiveSection = section;
                  state.aiAgentsActiveSubsection = null;
                },
                onSubsectionChange: (section) => (state.aiAgentsActiveSubsection = section),
                onReload: () => loadConfig(state),
                onSave: () => saveConfig(state),
                onApply: () => applyConfig(state),
                onUpdate: () => runUpdate(state),
                navRootLabel: "AI Agents",
                includeSections: [...AI_AGENTS_SECTION_KEYS],
              })
            : nothing
        }

        ${
          state.tab === "debug"
            ? renderDebug({
                loading: state.debugLoading,
                status: state.debugStatus,
                health: state.debugHealth,
                models: state.debugModels,
                heartbeat: state.debugHeartbeat,
                eventLog: state.eventLog,
                sparkMicTelemetry: state.sparkMicTelemetryLog,
                callMethod: state.debugCallMethod,
                callParams: state.debugCallParams,
                callResult: state.debugCallResult,
                callError: state.debugCallError,
                onCallMethodChange: (next) => (state.debugCallMethod = next),
                onCallParamsChange: (next) => (state.debugCallParams = next),
                onRefresh: () => loadDebug(state),
                onCall: () => callDebugMethod(state),
              })
            : nothing
        }

        ${
          state.tab === "logs"
            ? renderLogs({
                loading: state.logsLoading,
                error: state.logsError,
                file: state.logsFile,
                entries: state.logsEntries,
                filterText: state.logsFilterText,
                levelFilters: state.logsLevelFilters,
                autoFollow: state.logsAutoFollow,
                truncated: state.logsTruncated,
                onFilterTextChange: (next) => (state.logsFilterText = next),
                onLevelToggle: (level, enabled) => {
                  state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
                },
                onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                onRefresh: () => loadLogs(state, { reset: true }),
                onExport: (lines, label) => state.exportLogs(lines, label),
                onScroll: (event) => state.handleLogsScroll(event),
              })
            : nothing
        }
      </main>
      ${renderExecApprovalPrompt(state)}
      ${renderGatewayUrlConfirmation(state)}
      ${renderCommandPalette(state)}
      ${renderVoiceBar({
        state: state.voiceState,
        visible: state.voiceBarVisible,
        expanded: state.voiceBarExpanded,
        onToggleExpanded: () => state.toggleVoiceBarExpanded(),
        onDriveOpenClawChange: (enabled) => state.handleVoiceDriveOpenClawChange(enabled),
        onStartConversation: () => state.handleVoiceStartConversation(),
        onStopConversation: () => state.handleVoiceStopConversation(),
        onClose: () => state.handleVoiceClose(),
        onRetry: () => state.handleVoiceRetry(),
        sparkVoices: state.sparkVoices ?? [],
        ttsVoice: state.settings.ttsVoice || null,
        ttsInstruct: state.settings.ttsInstruct || null,
        ttsLanguage: state.settings.ttsLanguage || null,
        onTtsVoiceChange: (v) => state.handleTtsVoiceChange(v),
        onTtsInstructChange: (v) => state.handleTtsInstructChange(v),
        onTtsLanguageChange: (v) => state.handleTtsLanguageChange(v),
      })}
    </div>
  `;
}
