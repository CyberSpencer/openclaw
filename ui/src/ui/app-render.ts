import { html, nothing } from "lit";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { AppViewState } from "./app-view-state";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import {
  TAB_GROUPS,
  iconForTab,
  pathForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation";
import { icons } from "./icons";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatQueueItem, CronFormState } from "./ui-types";
import { refreshChatAvatar } from "./app-chat";
import { renderChat } from "./views/chat";
import { renderConfig } from "./views/config";
import { renderChannels } from "./views/channels";
import { renderCron } from "./views/cron";
import { renderDebug } from "./views/debug";
import { renderInstances } from "./views/instances";
import { renderLogs } from "./views/logs";
import { renderNodes } from "./views/nodes";
import { renderOrchestrator } from "./views/orchestrator";
import { renderOverview } from "./views/overview";
import { renderSessions } from "./views/sessions";
import { renderSettings } from "./views/settings";
import { renderChatThreadsNav } from "./views/chat-threads-nav";
import { renderExecApprovalPrompt } from "./views/exec-approval";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation";
import { renderCommandPalette } from "./views/command-palette";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices";
import { renderSkills } from "./views/skills";
import { renderChatControls, renderTab, renderThemeToggle } from "./app-render.helpers";
import { loadChannels } from "./controllers/channels";
import { loadPresence } from "./controllers/presence";
import { deleteSession, loadSessions, patchSession } from "./controllers/sessions";
import {
  installSkill,
  loadSkills,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillMessage,
} from "./controllers/skills";
import { loadNodes } from "./controllers/nodes";
import { loadChatHistory } from "./controllers/chat";
import { loadSubagentMonitor } from "./controllers/subagent-monitor";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals";
import {
  loadCronRuns,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
} from "./controllers/cron";
import { loadDebug, callDebugMethod } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { renderVoiceBar } from "./views/voice-bar";
import { loadChatThreads } from "./controllers/chat-threads";

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) return undefined;
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) return candidate;
  return identity?.avatarUrl;
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
  const cmdKey = (() => {
    if (typeof navigator === "undefined") return "Ctrl K";
    const platform = navigator.platform || "";
    return /mac|iphone|ipad|ipod/i.test(platform) ? "Cmd K" : "Ctrl K";
  })();
  const sparkEnabled = state.sparkStatus?.enabled;
  const sparkActive = state.sparkStatus?.active;
  const sparkKnown = Boolean(state.sparkStatus);
  const sparkHost = typeof state.sparkStatus?.host === "string" ? state.sparkStatus.host : null;
  const sparkLabel = state.sparkBusy
    ? "..."
    : !sparkKnown
      ? "..."
      : sparkEnabled === false
        ? "Off"
        : sparkActive
          ? "On"
          : "Fallback";
  const sparkDotClass = !sparkKnown || sparkEnabled === false ? "neutral" : sparkActive ? "ok" : "";
  const sparkTitle = !sparkKnown
    ? "DGX Spark status unavailable"
    : sparkEnabled === false
      ? "DGX Spark disabled"
      : sparkActive
        ? `DGX Spark active${sparkHost ? ` (${sparkHost})` : ""}`
        : `DGX Spark fallback${sparkHost ? ` (${sparkHost})` : ""}`;

  return html`
    <div class="shell ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""}">
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
          <div class="pill">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
          <button
            class="pill topbar-action-btn"
            @click=${() => state.openCommandPalette()}
            title=${`Search (${cmdKey})`}
            aria-label="Search (Command palette)"
          >
            <span class="pill-icon">${icons.search}</span>
            <span>Search</span>
            <span class="mono">${cmdKey}</span>
          </button>
          <button
            class="pill topbar-action-btn topbar-action-btn--status"
            ?disabled=${!state.connected || state.memorySearchBusy}
            @click=${() => state.handleMemorySearchToggle()}
            title="${state.memorySearchEnabled === false ? "Enable memory search" : "Disable memory search"}"
            aria-label="${state.memorySearchEnabled === false ? "Enable memory search" : "Disable memory search"}"
          >
            <span class="statusDot ${state.memorySearchEnabled === false ? "" : "ok"}"></span>
            <span>Memory</span>
            <span class="mono">
              ${state.memorySearchBusy
                ? "..."
                : state.memorySearchEnabled === false
                  ? "Off"
                  : "On"}
            </span>
          </button>
          <button
            class="pill topbar-action-btn topbar-action-btn--status"
            ?disabled=${!state.connected || state.nvidiaRouterBusy}
            @click=${() => state.handleNvidiaRouterToggle()}
            title="${state.nvidiaRouterEnabled === false ? "Enable NVIDIA Router" : "Disable NVIDIA Router"}"
            aria-label="${state.nvidiaRouterEnabled === false ? "Enable NVIDIA Router" : "Disable NVIDIA Router"}"
          >
            <span class="statusDot ${state.nvidiaRouterHealthy ? "ok" : ""}"></span>
            <span>NVIDIA Router</span>
          </button>
          <button
            class="pill topbar-action-btn topbar-action-btn--status"
            ?disabled=${!state.connected || state.sparkBusy}
            @click=${() => state.setTab("settings")}
            title=${sparkTitle}
            aria-label="DGX Spark status"
          >
            <span class="statusDot ${sparkDotClass}"></span>
            <span>DGX Spark</span>
            <span class="mono">${sparkLabel}</span>
          </button>
          <button
            class="pill topbar-action-btn topbar-action-btn--status ${state.personaPlexRunning ? "topbar-action-btn--ready" : "topbar-action-btn--off"}"
            ?disabled=${!state.connected || state.personaPlexBusy}
            @click=${() => state.handlePersonaPlexPreload()}
            title="${state.personaPlexRunning ? "PersonaPlex is running" : "Preload PersonaPlex"}"
            aria-label="${state.personaPlexRunning ? "PersonaPlex is running" : "Preload PersonaPlex"}"
          >
            <span class="statusDot ${state.personaPlexRunning ? "ok" : ""}"></span>
            <span>S2S</span>
          </button>
          <button
            class="voice-toggle-btn ${state.voiceBarVisible ? "voice-toggle-btn--active" : ""}"
            @click=${() => state.toggleVoiceBar()}
            title="${state.voiceBarVisible ? "Hide voice mode" : "Show voice mode"}"
            aria-label="${state.voiceBarVisible ? "Hide voice mode" : "Show voice mode"}"
          >
            ${icons.mic || "🎤"}
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
                onRefresh: () =>
                  loadChatThreads(state, { search: state.chatThreadsQuery }),
                onToggleThinking: () => {
                  if (state.onboarding) return;
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                },
                onToggleFocusMode: () => {
                  if (state.onboarding) return;
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
      <main class="content ${isChat ? "content--chat" : ""}">
        <section class="content-header">
          <div>
            <div class="page-title">${titleForTab(state.tab)}</div>
            <div class="page-sub">${subtitleForTab(state.tab)}</div>
          </div>
          <div class="page-meta">
            ${state.lastError ? html`<div class="pill danger">${state.lastError}</div>` : nothing}
            ${isChat ? renderChatControls(state) : nothing}
          </div>
        </section>

        ${
          state.tab === "orchestrator"
            ? renderOrchestrator(state)
            : nothing
        }

        ${
          state.tab === "overview"
            ? renderOverview({
                connected: state.connected,
                hello: state.hello,
                settings: state.settings,
                password: state.password,
                lastError: state.lastError,
                presenceCount,
                sessionsCount,
                cronEnabled: state.cronStatus?.enabled ?? null,
                cronNext,
                lastChannelsRefresh: state.channelsLastSuccess,
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
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                },
                onRefresh: () => loadSessions(state),
                onPatch: (key, patch) => patchSession(state, key, patch),
                onDelete: (key) => deleteSession(state, key),
              })
            : nothing
        }

        ${
          state.tab === "cron"
            ? renderCron({
                loading: state.cronLoading,
                status: state.cronStatus,
                jobs: state.cronJobs,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                onFormChange: (patch) => (state.cronForm = { ...state.cronForm, ...patch }),
                onRefresh: () => state.loadCron(),
                onToggleSchedulerEnabled: (enabled) => state.handleCronSchedulerToggle(enabled),
                onAdd: () => addCronJob(state),
                onToggle: (job, enabled) => toggleCronJob(state, job, enabled),
                onRun: (job) => runCronJob(state, job),
                onRemove: (job) => removeCronJob(state, job),
                onLoadRuns: (jobId) => loadCronRuns(state, jobId),
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
            ? renderChat({
                sessionKey: state.sessionKey,
                onSessionKeyChange: (next) => {
                  state.sessionKey = next;
                  state.chatMessage = "";
                  state.chatAttachments = [];
                  state.chatStream = null;
                  state.chatStreamStartedAt = null;
                  state.chatRunId = null;
                  state.chatModelSelection = null;
                  state.chatTaskPlan = null;
                  state.chatQueue = [];
                  state.resetToolStream();
                  state.resetChatScroll();
                  state.applySettings({
                    ...state.settings,
                    sessionKey: next,
                    lastActiveSessionKey: next,
                  });
                  void state.loadAssistantIdentity();
                  void loadChatHistory(state);
                  void refreshChatAvatar(state);
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
                onSubagentRefresh: () =>
                  loadSubagentMonitor(state, { quiet: false }),
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
                  if (state.onboarding) return;
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
                assistantName: state.assistantName,
                assistantAvatar: state.assistantAvatar,
              })
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
          state.tab === "debug"
            ? renderDebug({
                loading: state.debugLoading,
                status: state.debugStatus,
                health: state.debugHealth,
                models: state.debugModels,
                heartbeat: state.debugHeartbeat,
                eventLog: state.eventLog,
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
      })}
    </div>
  `;
}
