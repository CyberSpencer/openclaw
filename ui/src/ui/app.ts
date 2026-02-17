import { LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventLogEntry } from "./app-events.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type { SkillMessage } from "./controllers/skills.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { ResolvedTheme, ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
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
  NostrProfile,
} from "./types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleGlobalKeydown as handleGlobalKeydownRuntime,
  type KeyboardHost,
} from "./app-keyboard.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { renderApp } from "./app-render.ts";
import {
  hasRecentSubagentActivity,
  isTaskPlanIncomplete,
  resolveMemorySearchEnabled,
  resolveMemoryStoreLabel,
  resolveOnboardingMode,
  type AgentWaitResult,
  type CodexTeamRunResult,
  type ConfigGetResult,
  type DoctorRunResult,
  type OrchestratorGetResult,
  type OrchestratorSetResult,
  type RouterSetEnabledResult,
  type RouterStatusResult,
  type SessionSpawnResult,
  type SessionsSubagentsResult,
  type SparkStatusResult,
} from "./app-runtime-utils.ts";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
  syncUrlWithSessionKey as syncUrlWithSessionKeyInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type AgentEventPayload,
  type CompactionStatus,
  type ModelSelectionInfo,
  type ToolStreamEntry,
} from "./app-tool-stream.ts";
import {
  finishSparkMicWorkletRecording as finishSparkMicWorkletRecordingRuntime,
  getTtsRequestParams as getTtsRequestParamsRuntime,
  handleSpeakText as handleSpeakTextRuntime,
  handleSparkMicAudio as handleSparkMicAudioRuntime,
  handleStopSpeaking as handleStopSpeakingRuntime,
  playTtsChunksWithAudioElement as playTtsChunksWithAudioElementRuntime,
  startSparkMicMediaRecorder as startSparkMicMediaRecorderRuntime,
  startSparkMicRecording as startSparkMicRecordingRuntime,
  stopSparkMicRecording as stopSparkMicRecordingRuntime,
  tryStartSparkMicWorklet as tryStartSparkMicWorkletRuntime,
  type VoiceRuntimeHost,
} from "./app-voice-runtime.ts";
import { resolveInjectedAssistantIdentity } from "./assistant-identity.ts";
import {
  buildCommandPaletteActions,
  filterCommandPaletteActions,
  type CommandPaletteAction,
} from "./command-palette.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import { loadChatThreads } from "./controllers/chat-threads.ts";
import { loadSubagentMonitor } from "./controllers/subagent-monitor.ts";
import {
  createVoiceState,
  loadVoiceStatus,
  processVoiceInput,
  processVoiceInputSpark,
  startConversation,
  stopConversation,
  type VoiceState,
} from "./controllers/voice.ts";
import {
  loadOrchestratorState,
  saveOrchestratorState,
  type OrchestrationBoard,
  type OrchestrationCard,
  type OrchestrationCardRun,
  type OrchestrationLaneId,
} from "./orchestrator-store.ts";
import { loadSettings, type UiSettings } from "./storage.ts";
import {
  type ChatAttachment,
  type ChatQueueItem,
  type CronFormState,
  type TaskPlan,
} from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import { buildWorkletModuleUrl, supportsAudioWorkletRuntime } from "./worklets.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const WORKLET_VERSION = "20260210-v1";
const SPARK_STATUS_FAILURE_STOP_THRESHOLD = 3;
const injectedAssistantIdentity = resolveInjectedAssistantIdentity();
function unsafeHostCast<T>(value: unknown): T {
  return value as T;
}

type SessionRunBucket = {
  key: string;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatModelSelection: ModelSelectionInfo | null;
  chatTaskPlan: TaskPlan | null;
  compactionStatus: CompactionStatus | null;
  compactionClearTimer: number | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
};

type SessionRunHost = Parameters<typeof resetToolStreamInternal>[0] & {
  sessionKey: string;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  compactionStatus: CompactionStatus | null;
  compactionClearTimer: number | null;
};

@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private sidebarCloseTimer: number | null = null;
  private sessionRunHosts = new Map<string, { bucket: SessionRunBucket; host: SessionRunHost }>();

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatModelSelection: ModelSelectionInfo | null = null;
  @state() chatTaskPlan: TaskPlan | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  private chatDraftBySession: Record<string, string> = {};
  private chatQueueBySession: Record<string, ChatQueueItem[]> = {};
  private chatAttachmentsBySession: Record<string, ChatAttachment[]> = {};
  // ChatGPT-style thread list (separate from Sessions tab state)
  @state() chatThreadsLoading = false;
  @state() chatThreadsResult: SessionsListResult | null = null;
  @state() chatThreadsError: string | null = null;
  @state() chatThreadsQuery = "";
  @state() chatThreadsShowSubagents = false;
  private chatThreadsSearchTimer: number | null = null;
  private chatNewThreadLabelKeys = new Set<string>();
  // Subagent monitor for the active chat session (spawnedBy=sessionKey)
  @state() subagentMonitorLoading = false;
  @state() subagentMonitorResult: SessionsListResult | null = null;
  @state() subagentMonitorError: string | null = null;
  private subagentMonitorPollTimer: number | null = null;
  private subagentMonitorPollMs: number | null = null;
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;
  @state() orchestrationExpanded = true;

  // Command palette (Ctrl/Cmd+K)
  @state() commandPaletteOpen = false;
  @state() commandPaletteQuery = "";
  @state() commandPaletteIndex = 0;

  // Orchestrator (local browser state)
  private orchBoot = loadOrchestratorState();
  @state() orchBoards: OrchestrationBoard[] = this.orchBoot.boards;
  @state() orchSelectedBoardId: string = this.orchBoot.selectedBoardId;
  @state() orchSelectedCardId: string | null = null;
  @state() orchDragOverLaneId: string | null = null;
  @state() orchBusyCardId: string | null = null;
  @state() orchTemplateQuery = "";
  @state() orchDraft: {
    title: string;
    task: string;
    agentId: string;
    runner: "subagent" | "codex";
    model: string;
    thinking: string;
    timeoutSeconds: string;
    cleanup: "keep" | "delete";
    codexMode: "plan" | "apply" | "run";
    codexShellAllowlist: string;
    showAdvanced: boolean;
  } = {
    title: "",
    task: "",
    agentId: "main",
    runner: "subagent",
    model: "",
    thinking: "",
    timeoutSeconds: "",
    cleanup: "keep",
    codexMode: "apply",
    codexShellAllowlist: "",
    showAdvanced: false,
  };
  private orchSaveTimer: number | null = null;
  private orchServerHash: string | null = null;
  private orchServerLoaded = false;
  private orchServerSyncing = false;
  private orchServerSaveRequested = false;
  private orchScopeKey = "main";
  private orchRunIndex = new Map<string, { boardId: string; cardId: string }>();

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() pendingGatewayUrl: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() doctorRunning = false;
  @state() doctorResult: {
    ok: boolean;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  } | null = null;
  @state() doctorError: string | null = null;
  @state() gatewayRestartBusy = false;
  @state() gatewayRestartError: string | null = null;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" =
    "overview";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  // Voice mode state
  @state() voiceBarVisible = false;
  @state() voiceBarExpanded = false;
  voiceState: VoiceState = createVoiceState();
  @state() memorySearchEnabled: boolean | null = null;
  @state() memorySearchBusy = false;
  @state() memoryStoreLabel: string | null = null;
  @state() nvidiaRouterEnabled: boolean | null = null;
  @state() nvidiaRouterHealthy: boolean | null = null;
  @state() nvidiaRouterBusy = false;
  @state() sparkStatus: SparkStatusResult | null = null;
  @state() sparkBusy = false;
  @state() sparkMicRecording = false;
  private sparkMicMediaRecorder: MediaRecorder | null = null;
  private sparkMicStream: MediaStream | null = null;
  private sparkMicAudioContext: AudioContext | null = null;
  private sparkMicCaptureWorklet: AudioWorkletNode | null = null;
  private sparkMicPcmFrames: Int16Array[] = [];
  private sparkMicSampleRate = 16000;
  private sparkMicUsingWorklet = false;
  @state() ttsSpeaking = false;
  @state() ttsProgress: string | null = null;
  /** Message key being spoken (for inline TTS status on that message). */
  @state() ttsSpeakingMessageKey: string | null = null;
  /** Available Spark TTS voices from GET /v1/voices (for voice bar UI). */
  @state() sparkVoices: { id: string; name: string; description?: string }[] = [];
  private ttsAbortController: AbortController | null = null;
  private ttsCurrentAudio: HTMLAudioElement | null = null;
  private ttsPlaybackContext: AudioContext | null = null;
  private ttsPlaybackWorklet: AudioWorkletNode | null = null;
  private sparkMicChunks: Blob[] = [];
  private sparkMicRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  private sparkMicWorkletDisabledForSession = false;
  private sparkStatusPollInterval: number | null = null;
  private sparkStatusConsecutivePollFailures = 0;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  @state() chatManualRefreshInFlight = false;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  @state() chatNewMessagesBelow = false;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(unsafeHostCast<Parameters<typeof onPopStateInternal>[0]>(this));
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;
  private globalKeydownHandler = (event: KeyboardEvent) => this.handleGlobalKeydown(event);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.globalKeydownHandler);
    this.rebuildOrchRunIndex();
    handleConnected(unsafeHostCast<Parameters<typeof handleConnected>[0]>(this));
  }

  protected firstUpdated() {
    handleFirstUpdated(unsafeHostCast<Parameters<typeof handleFirstUpdated>[0]>(this));
  }

  disconnectedCallback() {
    handleDisconnected(unsafeHostCast<Parameters<typeof handleDisconnected>[0]>(this));
    window.removeEventListener("keydown", this.globalKeydownHandler);
    this.stopSparkStatusPolling();
    this.stopSubagentMonitorPolling();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(unsafeHostCast<Parameters<typeof handleUpdated>[0]>(this), changed);
    if (changed.has("connected")) {
      if (this.connected) {
        this.sparkStatusConsecutivePollFailures = 0;
        this.startSparkStatusPolling();
        void this.refreshSparkStatus();
      } else {
        this.stopSparkStatusPolling();
        this.sparkStatusConsecutivePollFailures = 0;
        this.sparkStatus = null;
        this.voiceState.sparkVoiceAvailable = false;
      }
    }
    if (changed.has("sessionKey")) {
      this.syncActiveRunState(this.sessionKey);
    }
    if (this.connected && changed.has("sessionKey")) {
      void this.loadOrchestratorFromGateway({ seedIfMissing: true });
    }
    if (changed.has("chatMessage") || changed.has("chatQueue") || changed.has("chatAttachments")) {
      this.persistComposeStateForSession(this.sessionKey);
    }
    this.handleSubagentMonitorUpdated(changed);
  }

  private startSubagentMonitorPolling(intervalMs: number) {
    if (this.subagentMonitorPollTimer != null && this.subagentMonitorPollMs === intervalMs) {
      return;
    }
    this.stopSubagentMonitorPolling();
    this.subagentMonitorPollMs = intervalMs;
    this.subagentMonitorPollTimer = window.setInterval(() => {
      void loadSubagentMonitor(this, { quiet: true });
    }, intervalMs);
  }

  private stopSubagentMonitorPolling() {
    if (this.subagentMonitorPollTimer == null) {
      return;
    }
    window.clearInterval(this.subagentMonitorPollTimer);
    this.subagentMonitorPollTimer = null;
    this.subagentMonitorPollMs = null;
  }

  private startSparkStatusPolling(intervalMs = 10_000) {
    if (this.sparkStatusPollInterval != null) {
      return;
    }
    this.sparkStatusPollInterval = window.setInterval(() => {
      if (!this.connected) {
        return;
      }
      void this.refreshSparkStatus();
    }, intervalMs);
  }

  private stopSparkStatusPolling() {
    if (this.sparkStatusPollInterval == null) {
      return;
    }
    window.clearInterval(this.sparkStatusPollInterval);
    this.sparkStatusPollInterval = null;
  }

  private isSparkVoiceAvailable(): boolean {
    return Boolean(this.connected && this.sparkStatus?.enabled && this.sparkStatus?.voiceAvailable);
  }

  private handleSubagentMonitorUpdated(changed: Map<PropertyKey, unknown>) {
    // Only keep polling while the chat tab is active; avoid background churn.
    if (this.tab !== "chat") {
      this.stopSubagentMonitorPolling();
      return;
    }

    const didEnterChat = changed.has("tab") && this.tab === "chat";
    const didChangeSession = changed.has("sessionKey");
    const didConnect = changed.has("connected") && this.connected;
    const didChangePlan = changed.has("chatTaskPlan");
    const didChangeRun = changed.has("chatRunId");

    if (
      this.connected &&
      (didEnterChat || didChangeSession || didConnect || didChangePlan || didChangeRun)
    ) {
      void loadSubagentMonitor(this, { quiet: true });
    }

    const runActive = Boolean(this.chatRunId) || this.chatStream !== null;
    const planActive = isTaskPlanIncomplete(this.chatTaskPlan);
    const recentSubagent = hasRecentSubagentActivity(this.subagentMonitorResult);
    const shouldPoll = this.connected && (runActive || planActive || recentSubagent);

    if (shouldPoll) {
      const intervalMs = runActive ? 1500 : 3000;
      this.startSubagentMonitorPolling(intervalMs);
    } else {
      this.stopSubagentMonitorPolling();
    }
  }

  connect() {
    connectGatewayInternal(unsafeHostCast<Parameters<typeof connectGatewayInternal>[0]>(this));
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      unsafeHostCast<Parameters<typeof handleChatScrollInternal>[0]>(this),
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      unsafeHostCast<Parameters<typeof handleLogsScrollInternal>[0]>(this),
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    const host = this.getSessionRunHost(this.sessionKey);
    resetToolStreamInternal(host);
  }

  resetChatScroll() {
    resetChatScrollInternal(unsafeHostCast<Parameters<typeof resetChatScrollInternal>[0]>(this));
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(unsafeHostCast<Parameters<typeof resetChatScrollInternal>[0]>(this));
    scheduleChatScrollInternal(
      unsafeHostCast<Parameters<typeof scheduleChatScrollInternal>[0]>(this),
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(unsafeHostCast<Parameters<typeof applySettingsInternal>[0]>(this), next);
  }

  setTab(next: Tab) {
    setTabInternal(unsafeHostCast<Parameters<typeof setTabInternal>[0]>(this), next);
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(unsafeHostCast<Parameters<typeof setThemeInternal>[0]>(this), next, context);
  }

  async loadOverview() {
    await loadOverviewInternal(unsafeHostCast<Parameters<typeof loadOverviewInternal>[0]>(this));
  }

  async loadCron() {
    await loadCronInternal(unsafeHostCast<Parameters<typeof loadCronInternal>[0]>(this));
  }

  async openCommandPalette() {
    if (this.commandPaletteOpen) {
      return;
    }
    this.commandPaletteOpen = true;
    this.commandPaletteQuery = "";
    this.commandPaletteIndex = 0;
    await this.updateComplete;
    const input = this.querySelector<HTMLInputElement>("#command-palette-input");
    input?.focus();
    input?.select();
  }

  closeCommandPalette() {
    this.commandPaletteOpen = false;
    this.commandPaletteQuery = "";
    this.commandPaletteIndex = 0;
  }

  getCommandPaletteActions(): CommandPaletteAction[] {
    const actions = filterCommandPaletteActions(
      buildCommandPaletteActions(unsafeHostCast<AppViewState>(this)),
      this.commandPaletteQuery,
    );
    const maxIndex = Math.max(0, actions.length - 1);
    if (this.commandPaletteIndex > maxIndex) {
      this.commandPaletteIndex = maxIndex;
    }
    return actions;
  }

  runCommandPaletteAction(action: CommandPaletteAction) {
    if (action.disabled) {
      return;
    }
    this.closeCommandPalette();
    try {
      const result = action.run();
      if (result) {
        void result;
      }
    } catch (err) {
      this.lastError = String(err);
    }
  }

  private scheduleOrchSave() {
    if (this.orchSaveTimer != null) {
      window.clearTimeout(this.orchSaveTimer);
      this.orchSaveTimer = null;
    }
    this.orchSaveTimer = window.setTimeout(() => {
      this.orchSaveTimer = null;
      try {
        saveOrchestratorState(
          {
            selectedBoardId: this.orchSelectedBoardId,
            boards: this.orchBoards,
          },
          this.orchScopeKey,
        );
      } catch {
        // ignore persistence failures (e.g. private mode)
      }
      void this.persistOrchestratorToGateway();
    }, 450);
  }

  async loadOrchestratorFromGateway(opts?: { seedIfMissing?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    const sessionKey = (this.sessionKey ?? "").trim();
    try {
      const res = await this.client.request<OrchestratorGetResult>(
        "orchestrator.get",
        sessionKey ? { sessionKey } : {},
      );
      const exists = Boolean(res?.exists);
      const hash = typeof res?.hash === "string" ? res.hash : "";
      const scopeKeyRaw = typeof res?.scopeKey === "string" ? res.scopeKey.trim() : "";
      const scopeKey = scopeKeyRaw || "main";
      const stateRaw = res?.state;

      this.orchScopeKey = scopeKey;
      if (hash) {
        this.orchServerHash = hash;
      }
      this.orchServerLoaded = true;

      const boards = Array.isArray(stateRaw?.boards)
        ? (stateRaw?.boards as OrchestrationBoard[])
        : null;
      const selectedBoardId =
        typeof stateRaw?.selectedBoardId === "string" && stateRaw.selectedBoardId.trim()
          ? stateRaw.selectedBoardId.trim()
          : null;

      if (exists && boards) {
        // Gateway is source-of-truth; apply it and sync to local storage.
        this.orchBoards = boards;
        if (selectedBoardId) {
          this.orchSelectedBoardId = selectedBoardId;
        }
        this.rebuildOrchRunIndex();
        try {
          saveOrchestratorState(
            {
              selectedBoardId: this.orchSelectedBoardId,
              boards: this.orchBoards,
            },
            this.orchScopeKey,
          );
        } catch {
          // ignore
        }
        return;
      }

      // No gateway store yet: seed it from local state so multiple clients stay in sync.
      // Prefer a scoped local cache first (if any) before pushing to gateway.
      const scopedLocal = loadOrchestratorState(this.orchScopeKey);
      if (Array.isArray(scopedLocal.boards) && scopedLocal.boards.length > 0) {
        this.orchBoards = scopedLocal.boards;
        this.orchSelectedBoardId = scopedLocal.selectedBoardId;
        this.rebuildOrchRunIndex();
      }
      if (opts?.seedIfMissing !== false) {
        void this.persistOrchestratorToGateway({ force: true });
      }
    } catch {
      // Best-effort only; orchestrator still works locally.
    }
  }

  handleOrchestratorStoreEvent(payload: unknown) {
    const obj =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { state?: unknown; hash?: unknown; scopeKey?: unknown })
        : null;
    if (!obj) {
      return;
    }
    const hash = typeof obj.hash === "string" ? obj.hash : "";
    const scopeKeyRaw = typeof obj.scopeKey === "string" ? obj.scopeKey.trim() : "";
    const scopeKey = scopeKeyRaw || "main";
    if (this.orchScopeKey && scopeKey !== this.orchScopeKey) {
      return;
    }

    const stateRaw = obj.state as
      | { version?: unknown; selectedBoardId?: unknown; boards?: unknown }
      | undefined;
    const boards = Array.isArray(stateRaw?.boards)
      ? (stateRaw?.boards as OrchestrationBoard[])
      : null;
    if (!boards) {
      return;
    }
    if (hash && this.orchServerHash && hash === this.orchServerHash) {
      return;
    }

    const selectedBoardId =
      typeof stateRaw?.selectedBoardId === "string" && stateRaw.selectedBoardId.trim()
        ? stateRaw.selectedBoardId.trim()
        : this.orchSelectedBoardId;

    this.orchScopeKey = scopeKey;
    this.orchBoards = boards;
    this.orchSelectedBoardId = selectedBoardId;
    this.rebuildOrchRunIndex();
    if (hash) {
      this.orchServerHash = hash;
    }
    this.orchServerLoaded = true;

    try {
      saveOrchestratorState(
        {
          selectedBoardId: this.orchSelectedBoardId,
          boards: this.orchBoards,
        },
        this.orchScopeKey,
      );
    } catch {
      // ignore
    }
  }

  private async persistOrchestratorToGateway(opts?: { force?: boolean }) {
    if (!this.client || !this.connected) {
      return;
    }
    if (!opts?.force && !this.orchServerLoaded) {
      // Avoid overwriting the gateway store before we've had a chance to read it once.
      // If the store doesn't exist yet, loadOrchestratorFromGateway will seed it.
      return;
    }
    const state = {
      version: 1,
      selectedBoardId: this.orchSelectedBoardId,
      boards: this.orchBoards,
    };
    const sessionKey = (this.sessionKey ?? "").trim();

    if (this.orchServerSyncing) {
      this.orchServerSaveRequested = true;
      return;
    }
    this.orchServerSyncing = true;
    try {
      const res = await this.client.request<OrchestratorSetResult>("orchestrator.set", {
        ...(sessionKey ? { sessionKey } : {}),
        state,
        baseHash: this.orchServerHash ?? undefined,
      });
      const nextHash = typeof res?.hash === "string" ? res.hash : "";
      const nextScopeKey = typeof res?.scopeKey === "string" ? res.scopeKey.trim() : "";
      if (nextHash) {
        this.orchServerHash = nextHash;
      }
      if (nextScopeKey) {
        this.orchScopeKey = nextScopeKey;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
      if (message.includes("baseHash") && message.includes("mismatch")) {
        try {
          const latest = await this.client.request<OrchestratorGetResult>(
            "orchestrator.get",
            sessionKey ? { sessionKey } : {},
          );
          const nextHash = typeof latest?.hash === "string" ? latest.hash : "";
          const nextScopeKey = typeof latest?.scopeKey === "string" ? latest.scopeKey.trim() : "";
          if (nextHash) {
            this.orchServerHash = nextHash;
          }
          if (nextScopeKey) {
            this.orchScopeKey = nextScopeKey;
          }
          const retry = await this.client.request<OrchestratorSetResult>("orchestrator.set", {
            ...(sessionKey ? { sessionKey } : {}),
            state,
          });
          const retryHash = typeof retry?.hash === "string" ? retry.hash : "";
          const retryScopeKey = typeof retry?.scopeKey === "string" ? retry.scopeKey.trim() : "";
          if (retryHash) {
            this.orchServerHash = retryHash;
          }
          if (retryScopeKey) {
            this.orchScopeKey = retryScopeKey;
          }
        } catch {
          // ignore
        }
      }
    } finally {
      this.orchServerSyncing = false;
      if (this.orchServerSaveRequested) {
        this.orchServerSaveRequested = false;
        void this.persistOrchestratorToGateway(opts);
      }
    }
  }

  private resolveSelectedOrchBoard(): OrchestrationBoard | null {
    const boards = this.orchBoards ?? [];
    if (boards.length === 0) {
      return null;
    }
    const selected =
      boards.find((board) => board.id === this.orchSelectedBoardId) ?? boards[0] ?? null;
    if (selected && selected.id !== this.orchSelectedBoardId) {
      this.orchSelectedBoardId = selected.id;
      this.scheduleOrchSave();
    }
    return selected;
  }

  private findOrchCard(cardId: string): {
    boardIndex: number;
    cardIndex: number;
    board: OrchestrationBoard;
    card: OrchestrationCard;
  } | null {
    const id = cardId.trim();
    if (!id) {
      return null;
    }
    for (let b = 0; b < this.orchBoards.length; b++) {
      const board = this.orchBoards[b];
      const idx = board.cards.findIndex((c) => c.id === id);
      if (idx !== -1) {
        return {
          boardIndex: b,
          cardIndex: idx,
          board,
          card: board.cards[idx],
        };
      }
    }
    return null;
  }

  private setOrchBoard(
    boardId: string,
    nextBoard: OrchestrationBoard,
    opts?: { persist?: boolean },
  ) {
    const nextBoards = this.orchBoards.map((b) => (b.id === boardId ? nextBoard : b));
    this.orchBoards = nextBoards;
    this.rebuildOrchRunIndex();
    if (opts?.persist !== false) {
      this.scheduleOrchSave();
    }
  }

  private updateOrchCard(
    cardId: string,
    updater: (card: OrchestrationCard, board: OrchestrationBoard) => OrchestrationCard,
    opts?: { persist?: boolean },
  ) {
    const found = this.findOrchCard(cardId);
    if (!found) {
      return;
    }
    const { boardIndex, cardIndex, board, card } = found;
    const nextCard = updater(card, board);
    const nextCards = [...board.cards];
    nextCards[cardIndex] = nextCard;
    const now = Date.now();
    const nextBoard: OrchestrationBoard = { ...board, cards: nextCards, updatedAt: now };
    const nextBoards = [...this.orchBoards];
    nextBoards[boardIndex] = nextBoard;
    this.orchBoards = nextBoards;
    // Index is based on runId, which we do not change here unless updater changes it.
    // Keep it simple and rebuild each time, this list stays small in practice.
    this.rebuildOrchRunIndex();
    if (opts?.persist !== false) {
      this.scheduleOrchSave();
    }
  }

  private normalizeAgentId(value: string): string {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
      return "main";
    }
    // Same normalization rules as core/src/routing/session-key.ts (path-safe + shell-friendly).
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/g, "")
      .replace(/-+$/g, "")
      .slice(0, 64);
    return normalized || "main";
  }

  private buildSubagentSystemPrompt(params: {
    requesterSessionKey?: string;
    childSessionKey: string;
    label?: string;
    task?: string;
  }): string {
    const taskText =
      typeof params.task === "string" && params.task.trim()
        ? params.task.replace(/\\s+/g, " ").trim()
        : "{{TASK_DESCRIPTION}}";
    const lines = [
      "# Subagent Context",
      "",
      "You are a **subagent** spawned by the main agent for a specific task.",
      "",
      "## Your Role",
      `- You were created to handle: ${taskText}`,
      "- Complete this task. That's your entire purpose.",
      "- You are NOT the main agent. Don't try to be.",
      "",
      "## Rules",
      "1. **Stay focused** - Do your assigned task, nothing else",
      "2. **Complete the task** - Your final message will be automatically reported to the main agent",
      "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
      "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
      "",
      "## Output Format",
      "When complete, your final response should include:",
      "- What you accomplished or found",
      "- Any relevant details the main agent should know",
      "- Keep it concise but informative",
      "",
      "## What You DON'T Do",
      "- NO user conversations (that's main agent's job)",
      "- NO external messages (email, tweets, etc.) unless explicitly tasked",
      "- NO cron jobs or persistent state",
      "- NO pretending to be the main agent",
      "- NO using the `message` tool directly",
      "",
      "## Session Context",
      params.label ? `- Label: ${params.label}` : undefined,
      params.requesterSessionKey
        ? `- Requester session: ${params.requesterSessionKey}.`
        : undefined,
      `- Your session: ${params.childSessionKey}.`,
      "",
    ].filter((line): line is string => line !== undefined);
    return lines.join("\\n");
  }

  orchSetDraft(patch: Partial<OpenClawApp["orchDraft"]>) {
    this.orchDraft = { ...this.orchDraft, ...patch };
  }

  orchSelectCard(cardId: string | null) {
    this.orchSelectedCardId = cardId;
  }

  orchCreateCard(laneId: OrchestrationLaneId = "backlog") {
    const board = this.resolveSelectedOrchBoard();
    if (!board) {
      return;
    }
    const now = Date.now();
    const id = generateUUID();
    const agentId =
      (this.agentsList?.defaultId ?? this.orchDraft.agentId ?? "main").trim() || "main";
    const runner = this.orchDraft.runner === "codex" ? "codex" : "subagent";
    const codexMode = runner === "codex" ? (this.orchDraft.codexMode ?? "apply") : undefined;
    const codexShellAllowlist =
      runner === "codex"
        ? (this.orchDraft.codexShellAllowlist ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 200)
        : undefined;
    const card: OrchestrationCard = {
      id,
      laneId,
      runner,
      title: "New task",
      task: "",
      agentId,
      cleanup: "keep",
      codexMode,
      codexShellAllowlist,
      createdAt: now,
      updatedAt: now,
    };
    const nextBoard: OrchestrationBoard = {
      ...board,
      cards: [...board.cards, card],
      updatedAt: now,
    };
    this.orchSelectedCardId = id;
    this.setOrchBoard(board.id, nextBoard);
  }

  orchUpdateCard(cardId: string, patch: Partial<OrchestrationCard>) {
    this.updateOrchCard(
      cardId,
      (card) => {
        const now = Date.now();
        const nextTitle = patch.title !== undefined ? String(patch.title) : card.title;
        const title = nextTitle.trim() || card.title;
        const agentIdRaw = patch.agentId !== undefined ? String(patch.agentId) : card.agentId;
        const agentId = agentIdRaw.trim() || card.agentId || "main";
        const task = patch.task !== undefined ? String(patch.task) : card.task;
        const laneId =
          patch.laneId !== undefined
            ? (String(patch.laneId).trim() as OrchestrationLaneId)
            : card.laneId;
        const runnerValue =
          patch.runner !== undefined ? String(patch.runner).trim() : (card.runner ?? "subagent");
        const runner = runnerValue === "codex" ? "codex" : "subagent";
        const modelValue = patch.model !== undefined ? String(patch.model) : (card.model ?? "");
        const model = modelValue.trim() ? modelValue.trim() : undefined;
        const thinkingValue =
          patch.thinking !== undefined ? String(patch.thinking) : (card.thinking ?? "");
        const thinking = thinkingValue.trim() ? thinkingValue.trim() : undefined;
        const codexModeRaw =
          patch.codexMode !== undefined ? String(patch.codexMode).trim() : card.codexMode;
        const codexMode =
          codexModeRaw === "plan" || codexModeRaw === "apply" || codexModeRaw === "run"
            ? codexModeRaw
            : card.codexMode;
        const codexShellAllowlist = Array.isArray(patch.codexShellAllowlist)
          ? patch.codexShellAllowlist
          : card.codexShellAllowlist;
        const timeoutSeconds =
          typeof patch.timeoutSeconds === "number" ? patch.timeoutSeconds : card.timeoutSeconds;
        const cleanup =
          patch.cleanup === "keep" || patch.cleanup === "delete" ? patch.cleanup : card.cleanup;
        const tags = Array.isArray(patch.tags) ? patch.tags : card.tags;
        return {
          ...card,
          title,
          task,
          agentId,
          laneId,
          runner,
          model,
          thinking,
          timeoutSeconds,
          cleanup,
          tags,
          codexMode,
          codexShellAllowlist,
          updatedAt: now,
        };
      },
      { persist: true },
    );
  }

  orchMoveCard(cardId: string, laneId: OrchestrationLaneId) {
    this.updateOrchCard(cardId, (card) => ({ ...card, laneId, updatedAt: Date.now() }), {
      persist: true,
    });
  }

  orchDeleteCard(cardId: string) {
    const found = this.findOrchCard(cardId);
    if (!found) {
      return;
    }
    const { board, boardIndex, cardIndex } = found;
    const nextCards = [...board.cards];
    nextCards.splice(cardIndex, 1);
    const now = Date.now();
    const nextBoard: OrchestrationBoard = { ...board, cards: nextCards, updatedAt: now };
    const nextBoards = [...this.orchBoards];
    nextBoards[boardIndex] = nextBoard;
    this.orchBoards = nextBoards;
    if (this.orchSelectedCardId === cardId) {
      this.orchSelectedCardId = null;
    }
    this.rebuildOrchRunIndex();
    this.scheduleOrchSave();
  }

  orchDuplicateCard(cardId: string) {
    const found = this.findOrchCard(cardId);
    if (!found) {
      return;
    }
    const { board, boardIndex, cardIndex, card } = found;
    const now = Date.now();
    const clone: OrchestrationCard = {
      ...card,
      id: generateUUID(),
      title: card.title.trim() ? `${card.title.trim()} (copy)` : "Copy",
      run: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const nextCards = [...board.cards];
    nextCards.splice(cardIndex + 1, 0, clone);
    const nextBoard: OrchestrationBoard = { ...board, cards: nextCards, updatedAt: now };
    const nextBoards = [...this.orchBoards];
    nextBoards[boardIndex] = nextBoard;
    this.orchBoards = nextBoards;
    this.orchSelectedCardId = clone.id;
    this.rebuildOrchRunIndex();
    this.scheduleOrchSave();
  }

  async orchAddDraftCard(opts?: { run?: boolean }) {
    const board = this.resolveSelectedOrchBoard();
    if (!board) {
      return;
    }
    const now = Date.now();
    const task = this.orchDraft.task ?? "";
    const oneLine = task.replace(/\\s+/g, " ").trim();
    const title =
      this.orchDraft.title.trim() ||
      (oneLine ? `${oneLine.slice(0, 52)}${oneLine.length > 52 ? "…" : ""}` : "New task");
    const agentId = this.orchDraft.agentId.trim() || this.agentsList?.defaultId || "main";
    const timeoutSecondsRaw = this.orchDraft.timeoutSeconds.trim();
    const timeoutSeconds = timeoutSecondsRaw ? Number(timeoutSecondsRaw) : NaN;
    const runner = this.orchDraft.runner === "codex" ? "codex" : "subagent";
    const model = this.orchDraft.model.trim() || undefined;
    const thinking = this.orchDraft.thinking.trim() || undefined;
    const cleanup = this.orchDraft.cleanup ?? "keep";
    const codexMode = runner === "codex" ? (this.orchDraft.codexMode ?? "apply") : undefined;
    const codexShellAllowlist =
      runner === "codex"
        ? (this.orchDraft.codexShellAllowlist ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 200)
        : undefined;

    const card: OrchestrationCard = {
      id: generateUUID(),
      laneId: "backlog",
      runner,
      title,
      task,
      agentId,
      model,
      thinking,
      timeoutSeconds: Number.isFinite(timeoutSeconds)
        ? Math.max(0, Math.floor(timeoutSeconds))
        : undefined,
      cleanup,
      codexMode,
      codexShellAllowlist,
      createdAt: now,
      updatedAt: now,
    };

    const nextBoard: OrchestrationBoard = {
      ...board,
      cards: [...board.cards, card],
      updatedAt: now,
    };
    this.orchBoards = this.orchBoards.map((b) => (b.id === board.id ? nextBoard : b));
    this.orchSelectedCardId = card.id;
    this.rebuildOrchRunIndex();
    this.scheduleOrchSave();

    // Reset the text fields, keep agent + advanced selections
    this.orchDraft = { ...this.orchDraft, title: "", task: "" };

    if (opts?.run) {
      await this.orchRunCard(card.id);
    }
  }

  async orchRunCard(cardId: string) {
    if (!this.client || !this.connected) {
      this.lastError = "Connect to the gateway before launching runs.";
      return;
    }
    const found = this.findOrchCard(cardId);
    if (!found) {
      return;
    }
    const { board, boardIndex, cardIndex, card } = found;
    const now = Date.now();
    this.orchBusyCardId = cardId;
    this.lastError = null;
    try {
      const normalizedAgentId = this.normalizeAgentId(card.agentId || "main");
      const runner = card.runner === "codex" ? "codex" : "subagent";

      const timeoutSeconds =
        typeof card.timeoutSeconds === "number" && Number.isFinite(card.timeoutSeconds)
          ? Math.max(0, Math.floor(card.timeoutSeconds))
          : 0;

      if (runner === "codex") {
        const codexSessionKey = `codex:${card.id}`;
        const mode = card.codexMode ?? "apply";
        const shellAllowlist = Array.isArray(card.codexShellAllowlist)
          ? card.codexShellAllowlist
          : [];

        // Optimistic UI: move to Running + attach a synthetic session key.
        const optimisticRun: OrchestrationCardRun = {
          runId: "",
          sessionKey: codexSessionKey,
          status: "accepted",
          createdAt: now,
          cleanup: { mode: "keep" },
        };
        const nextCards = [...board.cards];
        nextCards[cardIndex] = {
          ...card,
          laneId: "running",
          run: optimisticRun,
          updatedAt: now,
        };
        const nextBoard: OrchestrationBoard = { ...board, cards: nextCards, updatedAt: now };
        const nextBoards = [...this.orchBoards];
        nextBoards[boardIndex] = nextBoard;
        this.orchBoards = nextBoards;
        this.rebuildOrchRunIndex();

        const accepted = await this.client.request<CodexTeamRunResult>("codex-team.run", {
          cardId: card.id,
          title: card.title?.trim() || undefined,
          task: card.task,
          agentId: normalizedAgentId,
          mode,
          timeoutSeconds: timeoutSeconds > 0 ? timeoutSeconds : undefined,
          shellAllowlist,
        });

        const runId =
          accepted && typeof accepted.runId === "string" && accepted.runId.trim()
            ? accepted.runId.trim()
            : "";
        const sessionKey =
          accepted && typeof accepted.sessionKey === "string" && accepted.sessionKey.trim()
            ? accepted.sessionKey.trim()
            : codexSessionKey;

        this.updateOrchCard(
          cardId,
          (current) => {
            const run = current.run;
            if (!run) {
              return {
                ...current,
                laneId: "running",
                run: {
                  runId: runId || "",
                  sessionKey,
                  status: "accepted",
                  createdAt: now,
                  cleanup: { mode: "keep" },
                },
                updatedAt: Date.now(),
              };
            }
            return {
              ...current,
              laneId: "running",
              run: { ...run, runId: runId || run.runId, sessionKey, status: "accepted" },
              updatedAt: Date.now(),
            };
          },
          { persist: true },
        );
        return;
      }

      const requesterSessionKey = (this.sessionKey ?? "").trim() || "main";
      const cleanupMode = card.cleanup === "delete" ? "delete" : "keep";
      const modelOverride = (card.model ?? "").trim() || undefined;
      const thinking = (card.thinking ?? "").trim() || undefined;
      const idem = generateUUID();

      const result = await this.client.request<SessionSpawnResult>("sessions.spawn", {
        requesterSessionKey,
        task: card.task,
        label: card.title?.trim() || undefined,
        agentId: normalizedAgentId,
        model: modelOverride,
        thinking,
        runTimeoutSeconds: timeoutSeconds > 0 ? timeoutSeconds : undefined,
        cleanup: cleanupMode,
        idempotencyKey: idem,
        // Ensure announce routing stays inside the Control UI (avoid stale lastChannel deliveries).
        channel: "webchat",
      });

      const status = typeof result?.status === "string" ? result.status : "";
      if (status !== "accepted") {
        const message =
          typeof result?.error === "string" && result.error.trim()
            ? result.error.trim()
            : status
              ? `sessions.spawn ${status}`
              : "sessions.spawn failed";
        this.lastError = message;
        return;
      }

      const childSessionKey =
        typeof result?.childSessionKey === "string" && result.childSessionKey.trim()
          ? result.childSessionKey.trim()
          : "";
      const runId =
        typeof result?.runId === "string" && result.runId.trim() ? result.runId.trim() : idem;
      const warning = typeof result?.warning === "string" ? result.warning : undefined;

      if (!childSessionKey) {
        this.lastError = "sessions.spawn missing childSessionKey";
        return;
      }

      this.updateOrchCard(
        cardId,
        (current) => ({
          ...current,
          laneId: "running",
          run: {
            runId,
            sessionKey: childSessionKey,
            status: "accepted",
            createdAt: now,
            warning,
            cleanup: { mode: cleanupMode },
          },
          updatedAt: Date.now(),
        }),
        { persist: true },
      );
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.orchBusyCardId = null;
    }
  }

  async orchCleanupCardSession(cardId: string) {
    if (!this.client || !this.connected) {
      return;
    }
    const found = this.findOrchCard(cardId);
    if (!found) {
      return;
    }
    const run = found.card.run;
    if (!run?.sessionKey) {
      return;
    }
    if (run.sessionKey.startsWith("codex:")) {
      return;
    }
    if (run.cleanup?.mode === "delete") {
      return;
    }
    if (run.cleanup?.status === "pending") {
      return;
    }

    // Mark pending
    this.updateOrchCard(
      cardId,
      (card) => {
        const existing = card.run;
        if (!existing) {
          return card;
        }
        return {
          ...card,
          run: {
            ...existing,
            cleanup: {
              mode: existing.cleanup?.mode ?? "keep",
              status: "pending",
              error: undefined,
            },
          },
          updatedAt: Date.now(),
        };
      },
      { persist: true },
    );

    try {
      await this.client.request("sessions.delete", { key: run.sessionKey, deleteTranscript: true });
      this.updateOrchCard(
        cardId,
        (card) => {
          const existing = card.run;
          if (!existing) {
            return card;
          }
          return {
            ...card,
            run: {
              ...existing,
              cleanup: { ...(existing.cleanup ?? { mode: "keep" }), status: "done" },
            },
            updatedAt: Date.now(),
          };
        },
        { persist: true },
      );
    } catch (err) {
      this.updateOrchCard(
        cardId,
        (card) => {
          const existing = card.run;
          if (!existing) {
            return card;
          }
          return {
            ...card,
            run: {
              ...existing,
              cleanup: {
                ...(existing.cleanup ?? { mode: "keep" }),
                status: "error",
                error: String(err),
              },
            },
            updatedAt: Date.now(),
          };
        },
        { persist: true },
      );
    }
  }

  private persistComposeStateForSession(sessionKey: string) {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    this.chatDraftBySession[key] = this.chatMessage;
    this.chatQueueBySession[key] = (this.chatQueue ?? []).map((item) => ({
      ...item,
      attachments: item.attachments ? [...item.attachments] : undefined,
    }));
    this.chatAttachmentsBySession[key] = [...(this.chatAttachments ?? [])];
  }

  private restoreComposeStateForSession(sessionKey: string) {
    const key = sessionKey.trim();
    this.chatMessage = key ? (this.chatDraftBySession[key] ?? "") : "";
    this.chatQueue = key
      ? (this.chatQueueBySession[key] ?? []).map((item) => ({
          ...item,
          attachments: item.attachments ? [...item.attachments] : undefined,
        }))
      : [];
    this.chatAttachments = key ? [...(this.chatAttachmentsBySession[key] ?? [])] : [];
  }

  openChatSession(sessionKey: string) {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    const previousSessionKey = (this.sessionKey ?? "").trim();
    if (previousSessionKey) {
      this.persistComposeStateForSession(previousSessionKey);
    }

    this.sessionKey = key;
    this.restoreComposeStateForSession(key);
    this.syncActiveRunState(key);
    this.subagentMonitorResult = null;
    this.subagentMonitorError = null;
    this.resetChatScroll();
    this.applySettings({
      ...this.settings,
      sessionKey: key,
      lastActiveSessionKey: key,
    });
    syncUrlWithSessionKeyInternal(
      unsafeHostCast<Parameters<typeof syncUrlWithSessionKeyInternal>[0]>(this),
      key,
      true,
    );
    void this.loadAssistantIdentity();
    this.setTab("chat");
  }

  getSessionRunHost(sessionKey: string): SessionRunHost {
    const key = sessionKey.trim();
    const resolvedKey = key || "main";
    const existing = this.sessionRunHosts.get(resolvedKey);
    if (existing) {
      return existing.host;
    }

    const bucket: SessionRunBucket = {
      key: resolvedKey,
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      chatModelSelection: null,
      chatTaskPlan: null,
      compactionStatus: null,
      compactionClearTimer: null,
      toolStreamById: new Map<string, ToolStreamEntry>(),
      toolStreamOrder: [],
      chatToolMessages: [],
      toolStreamSyncTimer: null,
    };

    const isActiveSession = () => (this.sessionKey ?? "").trim() === resolvedKey;
    const syncIfActive = (apply: () => void) => {
      if (isActiveSession()) {
        apply();
      }
    };
    const syncChatRunId = (value: string | null) => {
      syncIfActive(() => {
        this.chatRunId = value;
      });
    };
    const syncChatModelSelection = (value: ModelSelectionInfo | null) => {
      syncIfActive(() => {
        this.chatModelSelection = value;
      });
    };
    const syncChatTaskPlan = (value: TaskPlan | null) => {
      syncIfActive(() => {
        this.chatTaskPlan = value;
      });
    };
    const syncChatToolMessages = (value: Record<string, unknown>[]) => {
      syncIfActive(() => {
        this.chatToolMessages = value;
      });
    };
    const syncCompactionStatus = (value: CompactionStatus | null) => {
      syncIfActive(() => {
        this.compactionStatus = value;
      });
    };
    const syncChatStream = (value: string | null) => {
      syncIfActive(() => {
        this.chatStream = value;
      });
    };
    const syncChatStreamStartedAt = (value: number | null) => {
      syncIfActive(() => {
        this.chatStreamStartedAt = value;
      });
    };

    const host: SessionRunHost = {
      sessionKey: resolvedKey,
      get chatRunId() {
        return bucket.chatRunId;
      },
      set chatRunId(value) {
        bucket.chatRunId = value;
        syncChatRunId(value);
      },
      get chatModelSelection() {
        return bucket.chatModelSelection;
      },
      set chatModelSelection(value) {
        bucket.chatModelSelection = value ?? null;
        syncChatModelSelection(value ?? null);
      },
      get chatTaskPlan() {
        return bucket.chatTaskPlan;
      },
      set chatTaskPlan(value) {
        bucket.chatTaskPlan = value ?? null;
        syncChatTaskPlan(value ?? null);
      },
      toolStreamById: bucket.toolStreamById,
      get toolStreamOrder() {
        return bucket.toolStreamOrder;
      },
      set toolStreamOrder(value) {
        bucket.toolStreamOrder = value;
      },
      get chatToolMessages() {
        return bucket.chatToolMessages;
      },
      set chatToolMessages(value) {
        bucket.chatToolMessages = value;
        syncChatToolMessages(value);
      },
      get toolStreamSyncTimer() {
        return bucket.toolStreamSyncTimer;
      },
      set toolStreamSyncTimer(value) {
        bucket.toolStreamSyncTimer = value;
      },
      get compactionStatus() {
        return bucket.compactionStatus;
      },
      set compactionStatus(value) {
        bucket.compactionStatus = value ?? null;
        syncCompactionStatus(value ?? null);
      },
      get compactionClearTimer() {
        return bucket.compactionClearTimer;
      },
      set compactionClearTimer(value) {
        bucket.compactionClearTimer = value;
      },
      get chatStream() {
        return bucket.chatStream;
      },
      set chatStream(value) {
        bucket.chatStream = value;
        syncChatStream(value);
      },
      get chatStreamStartedAt() {
        return bucket.chatStreamStartedAt;
      },
      set chatStreamStartedAt(value) {
        bucket.chatStreamStartedAt = value;
        syncChatStreamStartedAt(value);
      },
    };

    this.sessionRunHosts.set(resolvedKey, { bucket, host });
    return host;
  }

  resetAllSessionRunState() {
    for (const { bucket, host } of this.sessionRunHosts.values()) {
      // Cancel any pending compaction clear timer.
      if (bucket.compactionClearTimer != null) {
        window.clearTimeout(bucket.compactionClearTimer);
        bucket.compactionClearTimer = null;
      }
      resetToolStreamInternal(host);
    }
    this.sessionRunHosts.clear();
    this.syncActiveRunState(this.sessionKey);
  }

  private syncActiveRunState(sessionKey: string) {
    const host = this.getSessionRunHost(sessionKey);
    const entry = this.sessionRunHosts.get(host.sessionKey);
    const bucket = entry?.bucket;
    if (!bucket) {
      return;
    }
    this.chatRunId = bucket.chatRunId;
    this.chatStream = bucket.chatStream;
    this.chatStreamStartedAt = bucket.chatStreamStartedAt;
    this.chatModelSelection = bucket.chatModelSelection;
    this.chatTaskPlan = bucket.chatTaskPlan;
    this.compactionStatus = bucket.compactionStatus;
    this.chatToolMessages = bucket.chatToolMessages;
  }

  async reconcileInFlightOrchestratorRuns() {
    if (!this.client || !this.connected) {
      return;
    }

    const requesterSessionKey = (this.sessionKey ?? "").trim();
    if (!requesterSessionKey) {
      return;
    }

    const applyRunState = (
      cardId: string,
      nextStatus: "running" | "done" | "error",
      opts?: { startedAt?: number; endedAt?: number; error?: string },
    ) => {
      this.updateOrchCard(
        cardId,
        (card) => {
          const run = card.run;
          if (!run) {
            return card;
          }
          const laneId =
            nextStatus === "running"
              ? "running"
              : nextStatus === "done"
                ? card.laneId === "running"
                  ? "review"
                  : card.laneId
                : "failed";
          return {
            ...card,
            laneId,
            run: {
              ...run,
              status: nextStatus,
              startedAt: opts?.startedAt ?? run.startedAt,
              endedAt: opts?.endedAt ?? (nextStatus === "running" ? run.endedAt : Date.now()),
              error: nextStatus === "error" ? (opts?.error ?? run.error) : run.error,
            },
            updatedAt: Date.now(),
          };
        },
        { persist: true },
      );
    };

    let tasks: Array<{
      runId?: string;
      childSessionKey?: string;
      status?: "running" | "done" | "error";
      startedAt?: number;
      endedAt?: number;
    }> = [];

    try {
      const res = await this.client.request<SessionsSubagentsResult>("sessions.subagents", {
        requesterSessionKey,
        includeCompleted: true,
        limit: 200,
      });
      tasks = Array.isArray(res?.tasks) ? res.tasks : [];
    } catch {
      tasks = [];
    }

    const byRunId = new Map<string, (typeof tasks)[number]>();
    const byChildSessionKey = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      const runId = typeof task.runId === "string" ? task.runId.trim() : "";
      if (runId) {
        byRunId.set(runId, task);
      }
      const childSessionKey =
        typeof task.childSessionKey === "string" ? task.childSessionKey.trim() : "";
      if (childSessionKey) {
        byChildSessionKey.set(childSessionKey, task);
      }
    }

    const cards = (this.orchBoards ?? []).flatMap((board) => board.cards ?? []);
    for (const card of cards) {
      const run = card.run;
      if (!run) {
        continue;
      }
      if (run.status !== "accepted" && run.status !== "running") {
        continue;
      }

      const runId = (run.runId ?? "").trim();
      const childSessionKey = (run.sessionKey ?? "").trim();
      const task =
        (runId ? byRunId.get(runId) : undefined) ?? byChildSessionKey.get(childSessionKey);

      if (task) {
        if (task.status === "running") {
          applyRunState(card.id, "running", { startedAt: task.startedAt });
          continue;
        }
        if (task.status === "done") {
          applyRunState(card.id, "done", { startedAt: task.startedAt, endedAt: task.endedAt });
          continue;
        }
        if (task.status === "error") {
          applyRunState(card.id, "error", {
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            error: run.error ?? "Subagent run failed",
          });
          continue;
        }
      }

      if (runId) {
        try {
          const snapshot = await this.client.request<AgentWaitResult>("agent.wait", {
            runId,
            timeoutMs: 1,
          });
          const status = typeof snapshot?.status === "string" ? snapshot.status : "";
          const startedAt =
            typeof snapshot?.startedAt === "number" ? snapshot.startedAt : undefined;
          const endedAt = typeof snapshot?.endedAt === "number" ? snapshot.endedAt : undefined;
          const error = typeof snapshot?.error === "string" ? snapshot.error : undefined;
          if (status === "ok") {
            applyRunState(card.id, "done", { startedAt, endedAt });
            continue;
          }
          if (status === "error") {
            applyRunState(card.id, "error", { startedAt, endedAt, error });
            continue;
          }
        } catch {
          // best-effort reconciliation
        }
      }

      if (run.status === "accepted") {
        applyRunState(card.id, "running", { startedAt: run.createdAt });
      }
    }
  }

  handleOrchestratorAgentEvent(payload: AgentEventPayload) {
    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    if (!runId) {
      return;
    }
    const link = this.orchRunIndex.get(runId);
    if (!link) {
      return;
    }
    const found = this.findOrchCard(link.cardId);
    if (!found) {
      return;
    }
    const { board, card } = found;
    if (!card.run || card.run.runId !== runId) {
      return;
    }

    const stream = payload.stream;
    const data = payload.data ?? {};

    if (stream === "assistant") {
      const text = typeof data.text === "string" ? data.text : null;
      if (!text) {
        return;
      }
      this.updateOrchCard(
        card.id,
        (current) => {
          if (!current.run) {
            return current;
          }
          return {
            ...current,
            run: { ...current.run, lastText: text },
            updatedAt: Date.now(),
          };
        },
        { persist: false },
      );
      return;
    }

    if (stream === "model") {
      const phase = typeof data.phase === "string" ? data.phase : "";
      if (phase !== "selected") {
        return;
      }
      const provider = typeof data.provider === "string" ? data.provider : undefined;
      const model = typeof data.model === "string" ? data.model : undefined;
      const thinkLevel = typeof data.thinkLevel === "string" ? data.thinkLevel : undefined;
      this.updateOrchCard(
        card.id,
        (current) => {
          if (!current.run) {
            return current;
          }
          return {
            ...current,
            run: { ...current.run, provider, model, thinkLevel },
            updatedAt: Date.now(),
          };
        },
        { persist: true },
      );
      return;
    }

    if (stream !== "lifecycle") {
      return;
    }
    const phase = typeof data.phase === "string" ? data.phase : "";
    if (phase !== "start" && phase !== "end" && phase !== "error") {
      return;
    }

    const startedAt =
      typeof data.startedAt === "number" && Number.isFinite(data.startedAt)
        ? data.startedAt
        : undefined;
    const endedAt =
      typeof data.endedAt === "number" && Number.isFinite(data.endedAt) ? data.endedAt : undefined;
    const error = typeof data.error === "string" ? data.error : undefined;

    const hasLane = (lane: string) => board.lanes.some((l) => l.id === lane);
    const targetLane = (() => {
      if (phase === "start") {
        return hasLane("running") ? ("running" as OrchestrationLaneId) : card.laneId;
      }
      if (phase === "end") {
        return card.laneId === "running" && hasLane("review")
          ? ("review" as OrchestrationLaneId)
          : card.laneId;
      }
      if (phase === "error") {
        return hasLane("failed") ? ("failed" as OrchestrationLaneId) : card.laneId;
      }
      return card.laneId;
    })();

    this.updateOrchCard(
      card.id,
      (current) => {
        const run = current.run;
        if (!run) {
          return current;
        }
        const nextStatus = phase === "start" ? "running" : phase === "end" ? "done" : "error";
        const cleanupMode = run.cleanup?.mode ?? (current.cleanup === "delete" ? "delete" : "keep");
        const nextCleanup = run.cleanup ?? { mode: cleanupMode };
        return {
          ...current,
          laneId: targetLane,
          run: {
            ...run,
            status: nextStatus,
            startedAt: startedAt ?? run.startedAt,
            endedAt: phase === "start" ? run.endedAt : (endedAt ?? Date.now()),
            error: phase === "error" ? (error ?? run.error) : run.error,
            cleanup: nextCleanup,
          },
          updatedAt: Date.now(),
        };
      },
      { persist: true },
    );
  }

  private rebuildOrchRunIndex() {
    this.orchRunIndex.clear();
    for (const board of this.orchBoards ?? []) {
      for (const card of board.cards ?? []) {
        const runId = card.run?.runId?.trim();
        if (runId) {
          this.orchRunIndex.set(runId, { boardId: board.id, cardId: card.id });
        }
      }
    }
  }

  private handleGlobalKeydown(event: KeyboardEvent) {
    handleGlobalKeydownRuntime(unsafeHostCast<KeyboardHost>(this), event);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(
      unsafeHostCast<Parameters<typeof handleAbortChatInternal>[0]>(this),
    );
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      unsafeHostCast<Parameters<typeof removeQueuedMessageInternal>[0]>(this),
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      unsafeHostCast<Parameters<typeof handleSendChatInternal>[0]>(this),
      messageOverride,
      opts,
    );
  }

  private resolveDefaultAgentIdForNewThread(): string {
    const fromAgents = this.agentsList?.defaultId?.trim();
    if (fromAgents) {
      return this.normalizeAgentId(fromAgents);
    }
    const fromIdentity = this.assistantAgentId?.trim();
    if (fromIdentity) {
      return this.normalizeAgentId(fromIdentity);
    }
    const key = (this.sessionKey ?? "").trim().toLowerCase();
    if (key.startsWith("agent:")) {
      const parts = key.split(":");
      if (parts.length >= 2 && parts[1]) {
        return this.normalizeAgentId(parts[1]);
      }
    }
    return "main";
  }

  async handleChatNewThread() {
    if (!this.client || !this.connected) {
      return;
    }
    this.lastError = null;
    try {
      const agentId = this.resolveDefaultAgentIdForNewThread();
      const sessionKey = `agent:${agentId}:chat:${generateUUID()}`;
      await this.client.request("sessions.reset", { key: sessionKey });
      this.openChatSession(sessionKey);
      await loadChatThreads(this, { search: this.chatThreadsQuery });
    } catch (err) {
      this.lastError = String(err);
    }
  }

  handleChatThreadsQueryChange(next: string) {
    this.chatThreadsQuery = next;
    if (!this.client || !this.connected) {
      return;
    }
    if (this.chatThreadsSearchTimer != null) {
      window.clearTimeout(this.chatThreadsSearchTimer);
      this.chatThreadsSearchTimer = null;
    }
    const delay = next.trim().length ? 180 : 0;
    this.chatThreadsSearchTimer = window.setTimeout(() => {
      this.chatThreadsSearchTimer = null;
      void loadChatThreads(this, { search: this.chatThreadsQuery });
    }, delay);
  }

  async handleChatThreadRename(key: string) {
    if (!this.client || !this.connected) {
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    const row = this.chatThreadsResult?.sessions?.find((entry) => entry.key === trimmed);
    const currentLabel = (row?.label ?? "").trim();
    const suggested = currentLabel || row?.derivedTitle || row?.displayName || trimmed;
    const next = window.prompt("Rename chat", suggested);
    if (next == null) {
      return;
    }
    const label = next.trim();
    try {
      await this.client.request("sessions.patch", { key: trimmed, label: label ? label : null });
      await loadChatThreads(this, { search: this.chatThreadsQuery });
    } catch (err) {
      this.chatThreadsError = String(err);
    }
  }

  async handleChatThreadDelete(key: string) {
    if (!this.client || !this.connected) {
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    const confirmed = window.confirm(
      `Delete chat "${trimmed}"?\\n\\nDeletes the session entry and archives its transcript.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.client.request("sessions.delete", { key: trimmed, deleteTranscript: true });
      if (this.sessionKey === trimmed) {
        const fallback =
          this.settings.lastActiveSessionKey && this.settings.lastActiveSessionKey !== trimmed
            ? this.settings.lastActiveSessionKey
            : "main";
        this.openChatSession(fallback);
      }
      await loadChatThreads(this, { search: this.chatThreadsQuery });
    } catch (err) {
      this.chatThreadsError = String(err);
    }
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    this.pendingGatewayUrl = null;
    applySettingsInternal(unsafeHostCast<Parameters<typeof applySettingsInternal>[0]>(this), {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  // Voice mode handlers
  async loadVoiceStatus() {
    if (!this.client || !this.connected) {
      return;
    }
    this.voiceState.client = this.client;
    this.voiceState.connected = this.connected;
    await loadVoiceStatus(this.voiceState);
    this.voiceState.sparkVoiceAvailable = this.isSparkVoiceAvailable();
    this.requestUpdate();
  }

  /** Load Spark TTS voices from gateway (GET .../v1/voices) for voice bar UI. */
  async loadSparkVoices() {
    if (!this.client || !this.connected) {
      return;
    }
    try {
      const result = await this.client.request("spark.voice.voices", {});
      const raw = (result as { voices?: unknown[] })?.voices;
      const list: { id: string; name: string; description?: string }[] = Array.isArray(raw)
        ? raw
            .map((v) => {
              const o = v as Record<string, unknown>;
              const id =
                typeof o?.id === "string"
                  ? o.id
                  : typeof o?.name === "string"
                    ? o.name.toLowerCase()
                    : "";
              const name = typeof o?.name === "string" ? o.name : id;
              return id
                ? {
                    id,
                    name,
                    description: typeof o?.description === "string" ? o.description : undefined,
                  }
                : null;
            })
            .filter((x): x is NonNullable<typeof x> => x != null)
        : [];
      this.sparkVoices = list;
      this.requestUpdate();
    } catch {
      this.sparkVoices = [];
      this.requestUpdate();
    }
  }

  toggleVoiceBar() {
    this.voiceBarVisible = !this.voiceBarVisible;
    if (this.voiceBarVisible) {
      this.voiceState.client = this.client;
      this.voiceState.connected = this.connected;
      this.voiceState.sparkVoiceAvailable = this.isSparkVoiceAvailable();
      this.voiceState.ttsVoice = this.settings.ttsVoice || null;
      this.voiceState.ttsInstruct = this.settings.ttsInstruct || null;
      this.voiceState.ttsLanguage = this.settings.ttsLanguage || null;
      if (this.voiceState.mode === "spark") {
        this.voiceState.enabled = true;
      } else if (!this.voiceState.capabilities) {
        void this.loadVoiceStatus();
      }
      void this.loadSparkVoices();
    }
  }

  toggleVoiceBarExpanded() {
    this.voiceBarExpanded = !this.voiceBarExpanded;
    if (this.voiceBarExpanded && this.voiceBarVisible && this.sparkVoices.length === 0) {
      void this.loadSparkVoices();
    }
  }

  /**
   * Start a natural voice conversation with VAD.
   * Mic goes live, VAD detects speech end, processes, responds, loops.
   */
  handleVoiceStartConversation() {
    if (this.voiceState.mode === "spark" && !this.isSparkVoiceAvailable()) {
      this.voiceState.error = "Spark voice unavailable. Conversation start is blocked.";
      this.requestUpdate();
      return;
    }
    this.voiceState.sessionKey = this.sessionKey;
    this.voiceState.sparkVoiceAvailable = this.isSparkVoiceAvailable();
    this.voiceState.ttsVoice = this.settings.ttsVoice || null;
    this.voiceState.ttsInstruct = this.settings.ttsInstruct || null;
    this.voiceState.ttsLanguage = this.settings.ttsLanguage || null;
    void startConversation(
      this.voiceState,
      () => this.requestUpdate(),
      async ({ audioBase64, format }: { audioBase64: string; format: string }) => {
        if (this.voiceState.mode === "spark") {
          return await processVoiceInputSpark(this.voiceState, audioBase64, format);
        }
        return await processVoiceInput(this.voiceState, audioBase64);
      },
    ).catch((err) => {
      this.voiceState.error = String(err);
      this.requestUpdate();
    });
    this.requestUpdate();
  }

  /**
   * Stop the voice conversation.
   */
  handleVoiceStopConversation() {
    stopConversation(this.voiceState);
    this.requestUpdate();
  }

  handleVoiceRetry() {
    this.voiceState.error = null;
    this.voiceState.transcription = null;
    this.voiceState.response = null;
    this.requestUpdate();
  }

  handleVoiceClose() {
    stopConversation(this.voiceState);
    this.voiceBarVisible = false;
    this.requestUpdate();
  }

  handleVoiceDriveOpenClawChange(enabled: boolean) {
    this.voiceState.driveOpenClaw = enabled;
    this.requestUpdate();
  }

  handleTtsVoiceChange(voice: string | null) {
    this.applySettings({ ...this.settings, ttsVoice: voice ?? "" });
    this.voiceState.ttsVoice = this.settings.ttsVoice || null;
  }

  handleTtsInstructChange(instruct: string | null) {
    this.applySettings({ ...this.settings, ttsInstruct: instruct ?? "" });
    this.voiceState.ttsInstruct = this.settings.ttsInstruct || null;
  }

  handleTtsLanguageChange(language: string | null) {
    this.applySettings({ ...this.settings, ttsLanguage: language ?? "" });
    this.voiceState.ttsLanguage = this.settings.ttsLanguage || null;
  }

  private async readConfigSnapshot(): Promise<ConfigSnapshot | null> {
    if (!this.client || !this.connected) {
      return null;
    }
    try {
      return await this.client.request("config.get", {});
    } catch (err) {
      this.lastError = String(err);
      return null;
    }
  }

  async refreshMemoryToggleState() {
    const snapshot = await this.readConfigSnapshot();
    if (!snapshot) {
      return;
    }
    this.memorySearchEnabled = resolveMemorySearchEnabled(snapshot.config);
    this.memoryStoreLabel = resolveMemoryStoreLabel(snapshot.config);
  }

  async handleMemorySearchToggle() {
    if (!this.client || !this.connected || this.memorySearchBusy) {
      return;
    }
    this.memorySearchBusy = true;
    this.lastError = null;
    try {
      const snapshot = await this.readConfigSnapshot();
      if (!snapshot) {
        return;
      }
      const baseHash = typeof snapshot.hash === "string" ? snapshot.hash.trim() : "";
      if (!baseHash) {
        this.lastError = "Config hash missing, reload and retry.";
        return;
      }

      const current = resolveMemorySearchEnabled(snapshot.config);
      const nextEnabled = !current;
      const patch = {
        agents: {
          defaults: {
            memorySearch: {
              enabled: nextEnabled,
            },
          },
        },
      };

      await this.client.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash,
        sessionKey: this.applySessionKey || this.sessionKey,
        note: `topbar memory toggle: ${nextEnabled ? "enabled" : "disabled"}`,
      });

      this.memorySearchEnabled = nextEnabled;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.memorySearchBusy = false;
    }
  }

  async handleCronSchedulerToggle(enabled: boolean) {
    if (!this.client || !this.connected || this.cronBusy) {
      return;
    }
    this.cronBusy = true;
    this.cronError = null;
    try {
      const snapshot = await this.client.request<ConfigGetResult>("config.get", {});
      const baseHash = typeof snapshot.hash === "string" ? snapshot.hash.trim() : "";
      if (!baseHash) {
        this.cronError = "Config hash missing, reload and retry.";
        return;
      }

      const patch = {
        cron: {
          enabled,
        },
      };

      await this.client.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash,
        sessionKey: this.applySessionKey || this.sessionKey,
        note: `cron scheduler toggle: ${enabled ? "enabled" : "disabled"}`,
      });

      this.cronStatus = this.cronStatus
        ? { ...this.cronStatus, enabled }
        : { enabled, jobs: 0, nextWakeAtMs: null };
    } catch (err) {
      this.cronError = String(err);
    } finally {
      this.cronBusy = false;
    }
  }

  async handleDoctorRun(opts?: { deep?: boolean }) {
    if (!this.client || !this.connected || this.doctorRunning) {
      return;
    }
    this.doctorRunning = true;
    this.doctorError = null;
    this.doctorResult = null;
    try {
      const res = await this.client.request<DoctorRunResult>("doctor.run", {
        timeoutMs: 120_000,
        deep: opts?.deep === true,
      });
      const result = {
        ok: res?.ok === true,
        exitCode: typeof res?.exitCode === "number" ? res.exitCode : null,
        signal: typeof res?.signal === "string" ? res.signal : null,
        durationMs: typeof res?.durationMs === "number" ? res.durationMs : 0,
        timedOut: res?.timedOut === true,
        stdout: typeof res?.stdout === "string" ? res.stdout : "",
        stderr: typeof res?.stderr === "string" ? res.stderr : "",
      };
      this.doctorResult = result;
      if (!result.ok) {
        this.doctorError = result.timedOut ? "Doctor timed out." : "Doctor failed.";
      }
    } catch (err) {
      this.doctorError = String(err);
    } finally {
      this.doctorRunning = false;
    }
  }

  async handleGatewayRestart() {
    if (!this.client || !this.connected || this.gatewayRestartBusy) {
      return;
    }
    this.gatewayRestartBusy = true;
    this.gatewayRestartError = null;
    try {
      await this.client.request("gateway.restart", { delayMs: 500, reason: "control-ui" });
    } catch (err) {
      this.gatewayRestartError = String(err);
    } finally {
      this.gatewayRestartBusy = false;
    }
  }

  async refreshNvidiaRouterStatus() {
    if (!this.client || !this.connected) {
      return;
    }
    this.nvidiaRouterBusy = true;
    try {
      const status = await this.client.request<RouterStatusResult>("router.status", {});
      this.nvidiaRouterEnabled = status.enabled !== false;
      this.nvidiaRouterHealthy = status.enabled === false ? false : Boolean(status.healthy);
    } catch {
      this.nvidiaRouterEnabled = null;
      this.nvidiaRouterHealthy = null;
    } finally {
      this.nvidiaRouterBusy = false;
    }
  }

  async handleNvidiaRouterToggle(forceEnabled?: boolean) {
    if (!this.client || !this.connected || this.nvidiaRouterBusy) {
      return;
    }
    this.nvidiaRouterBusy = true;
    this.lastError = null;
    try {
      const currentEnabled = this.nvidiaRouterEnabled !== false;
      const nextEnabled = typeof forceEnabled === "boolean" ? forceEnabled : !currentEnabled;
      const result = await this.client.request<RouterSetEnabledResult>("router.setEnabled", {
        enabled: nextEnabled,
      });
      this.nvidiaRouterEnabled = result.enabled !== false;
      this.nvidiaRouterHealthy = result.enabled === false ? false : Boolean(result.healthy);
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.nvidiaRouterBusy = false;
    }
  }

  async refreshSparkStatus() {
    if (!this.client || !this.connected) {
      return;
    }
    this.sparkBusy = true;
    let pollSucceeded = false;
    try {
      const status = await this.client.request<SparkStatusResult>("spark.status", {});
      this.sparkStatus = status;
      this.sparkStatusConsecutivePollFailures = 0;
      pollSucceeded = true;
    } catch {
      this.sparkStatusConsecutivePollFailures += 1;
      if (this.sparkStatusConsecutivePollFailures >= SPARK_STATUS_FAILURE_STOP_THRESHOLD) {
        this.sparkStatus = null;
      }
    } finally {
      this.sparkBusy = false;
    }

    const available = this.isSparkVoiceAvailable();
    const wasAvailable = this.voiceState.sparkVoiceAvailable;
    this.voiceState.sparkVoiceAvailable = available;
    if (
      this.voiceState.mode === "spark" &&
      wasAvailable &&
      !available &&
      this.voiceState.conversationActive
    ) {
      stopConversation(this.voiceState);
      this.voiceState.error = pollSucceeded
        ? "Spark voice became unavailable. Conversation stopped."
        : "Spark status polling failed repeatedly. Conversation stopped.";
      this.requestUpdate();
    }
  }

  // ---------------------------------------------------------------------------
  // Spark voice mic (standalone, NOT PersonaPlex)
  // ---------------------------------------------------------------------------

  async handleSparkMicClick() {
    if (!this.isSparkVoiceAvailable()) {
      this.lastError = "Spark voice unavailable. Mic is disabled until DGX voice recovers.";
      return;
    }
    if (this.sparkMicRecording) {
      void this.stopSparkMicRecording();
    } else {
      await this.startSparkMicRecording();
    }
  }

  private supportsAudioWorklet(): boolean {
    return supportsAudioWorkletRuntime();
  }

  private base64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private async ensureTtsPlaybackWorklet(): Promise<boolean> {
    if (this.ttsPlaybackContext && this.ttsPlaybackWorklet) {
      return true;
    }
    if (!this.supportsAudioWorklet()) {
      return false;
    }

    try {
      const ctx = new AudioContext({ sampleRate: 24000 });
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
      }
      const workletUrl = buildWorkletModuleUrl(
        "playback-processor.js",
        WORKLET_VERSION,
        this.basePath,
      );
      await ctx.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(ctx, "playback-processor");
      worklet.connect(ctx.destination);

      this.ttsPlaybackContext = ctx;
      this.ttsPlaybackWorklet = worklet;
      return true;
    } catch {
      return false;
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1] || "";
        resolve(base64);
      };
      reader.addEventListener("error", () => {
        reject(reader.error ?? new Error("FileReader error"));
      });
      reader.readAsDataURL(blob);
    });
  }

  private async handleSparkMicAudio(params: {
    audioBase64: string;
    format: string;
    sampleRate?: number;
  }) {
    await handleSparkMicAudioRuntime(unsafeHostCast<VoiceRuntimeHost>(this), params);
  }

  private async startSparkMicRecording() {
    await startSparkMicRecordingRuntime(unsafeHostCast<VoiceRuntimeHost>(this));
  }

  private async tryStartSparkMicWorklet(stream: MediaStream): Promise<boolean> {
    return await tryStartSparkMicWorkletRuntime(unsafeHostCast<VoiceRuntimeHost>(this), stream);
  }

  private startSparkMicMediaRecorder(stream: MediaStream): void {
    startSparkMicMediaRecorderRuntime(unsafeHostCast<VoiceRuntimeHost>(this), stream);
  }

  private async stopSparkMicRecording() {
    await stopSparkMicRecordingRuntime(unsafeHostCast<VoiceRuntimeHost>(this));
  }

  private async finishSparkMicWorkletRecording() {
    await finishSparkMicWorkletRecordingRuntime(unsafeHostCast<VoiceRuntimeHost>(this));
  }

  /** Returns optional TTS params (voice, instruct, language) for spark.voice.tts. Only includes defined values. */
  /** Returns optional TTS params (voice, instruct, language) from persisted settings. Only includes non-empty values. */
  private getTtsRequestParams(): { voice?: string; instruct?: string; language?: string } {
    return getTtsRequestParamsRuntime(unsafeHostCast<VoiceRuntimeHost>(this));
  }

  handleStopSpeaking() {
    handleStopSpeakingRuntime(unsafeHostCast<VoiceRuntimeHost>(this));
  }

  async handleSpeakText(text: string, messageKey?: string) {
    await handleSpeakTextRuntime(unsafeHostCast<VoiceRuntimeHost>(this), text, messageKey);
  }

  private async playTtsChunksWithAudioElement(chunks: string[]): Promise<void> {
    await playTtsChunksWithAudioElementRuntime(unsafeHostCast<VoiceRuntimeHost>(this), chunks);
  }

  async refreshTopbarControls() {
    if (!this.client || !this.connected) {
      return;
    }
    await Promise.all([
      this.refreshMemoryToggleState(),
      this.refreshNvidiaRouterStatus(),
      this.refreshSparkStatus(),
    ]);
  }

  render() {
    return renderApp(unsafeHostCast<AppViewState>(this));
  }
}
