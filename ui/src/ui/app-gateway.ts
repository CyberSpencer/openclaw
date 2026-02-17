import type { EventLogEntry } from "./app-events.ts";
import type { OpenClawApp } from "./app.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type {
  AgentsListResult,
  PresenceEntry,
  HealthSnapshot,
  SessionsListResult,
  StatusSummary,
} from "./types.ts";
import { flushChatQueueForEvent } from "./app-chat.ts";
import {
  applySettings,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings.ts";
import { handleAgentEvent, type AgentEventPayload } from "./app-tool-stream.ts";
import { loadAgents } from "./controllers/agents.ts";
import { loadAssistantIdentity } from "./controllers/assistant-identity.ts";
import { loadChatThreads } from "./controllers/chat-threads.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { handleChatEvent, type ChatState } from "./controllers/chat.ts";
import { loadDevices } from "./controllers/devices.ts";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadSubagentMonitor } from "./controllers/subagent-monitor.ts";
import { GatewayBrowserClient } from "./gateway.ts";

type GatewayHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  getSessionRunHost: (sessionKey: string) => unknown;
  resetAllSessionRunState: () => void;
  chatRunId: string | null;
  chatThreadsQuery: string;
  chatThreadsLoading: boolean;
  chatThreadsResult: SessionsListResult | null;
  chatThreadsError: string | null;
  subagentMonitorLoading?: boolean;
  subagentMonitorResult?: SessionsListResult | null;
  subagentMonitorError?: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  refreshTopbarControls?: () => Promise<void> | void;
  handleOrchestratorAgentEvent?: (payload: AgentEventPayload) => void;
  handleOrchestratorStoreEvent?: (payload: unknown) => void;
  handleChatThreadFinalEvent?: (sessionKey: string) => void;
  loadOrchestratorFromGateway?: (opts?: { seedIfMissing?: boolean }) => Promise<void> | void;
  reconcileInFlightOrchestratorRuns?: () => Promise<void> | void;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

export function connectGateway(host: GatewayHost) {
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.execApprovalQueue = [];
  host.execApprovalError = null;

  host.client?.stop();
  host.client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    onHello: (hello) => {
      host.connected = true;
      host.lastError = null;
      host.hello = hello;
      applySnapshot(host, hello);
      // Reset orphaned run state from before disconnect.
      // Any in-flight run's final event may have been lost during the disconnect window.
      host.resetAllSessionRunState();
      void loadAssistantIdentity(host as unknown as OpenClawApp);
      void host.loadOrchestratorFromGateway?.({ seedIfMissing: true });
      void host.reconcileInFlightOrchestratorRuns?.();
      void loadAgents(host as unknown as OpenClawApp);
      void loadNodes(host as unknown as OpenClawApp, { quiet: true });
      void loadDevices(host as unknown as OpenClawApp, { quiet: true });
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      void host.refreshTopbarControls?.();
    },
    onClose: ({ code, reason }) => {
      host.connected = false;
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
    },
    onEvent: (evt) => handleGatewayEvent(host, evt),
    onGap: ({ expected, received }) => {
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
    },
  });
  host.client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    const payload = evt.payload;
    if (payload) {
      host.handleOrchestratorAgentEvent?.(payload);
    }
    const sessionKey =
      payload && typeof (payload as { sessionKey?: unknown }).sessionKey === "string"
        ? String((payload as { sessionKey?: string }).sessionKey)
        : host.sessionKey;
    const runHost = host.getSessionRunHost(sessionKey);
    handleAgentEvent(runHost as Parameters<typeof handleAgentEvent>[0], payload);
    return;
  }

  if (evt.event === "orchestrator") {
    host.handleOrchestratorStoreEvent?.(evt.payload);
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload;
    if (payload?.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) {
      return;
    }

    const runHost = host.getSessionRunHost(sessionKey) as {
      chatRunId: string | null;
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatTaskPlan: unknown;
    };
    const isActive = sessionKey === host.sessionKey;

    const chatProxy: ChatState = {
      client: host.client as unknown as ChatState["client"],
      connected: host.connected,
      sessionKey,
      chatLoading: false,
      chatMessages: [],
      chatThinkingLevel: null,
      chatSending: false,
      chatMessage: "",
      chatAttachments: [],
      get chatRunId() {
        return runHost.chatRunId;
      },
      set chatRunId(value) {
        runHost.chatRunId = value;
      },
      get chatStream() {
        return runHost.chatStream;
      },
      set chatStream(value) {
        runHost.chatStream = value;
      },
      get chatStreamStartedAt() {
        return runHost.chatStreamStartedAt;
      },
      set chatStreamStartedAt(value) {
        runHost.chatStreamStartedAt = value;
      },
      get chatTaskPlan() {
        return runHost.chatTaskPlan as ChatState["chatTaskPlan"];
      },
      set chatTaskPlan(value) {
        runHost.chatTaskPlan = value;
      },
      get lastError() {
        return host.lastError;
      },
      set lastError(value) {
        if (isActive) {
          host.lastError = value;
        }
      },
    };

    const state = handleChatEvent(chatProxy, payload);

    if ((state === "final" || state === "error" || state === "aborted") && isActive) {
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
    }

    if (state === "final") {
      host.handleChatThreadFinalEvent?.(sessionKey);
      if (isActive) {
        void loadChatHistory(host as unknown as OpenClawApp);
      }
      void loadChatThreads(host as unknown as Parameters<typeof loadChatThreads>[0], {
        search: host.chatThreadsQuery,
      });
      if (isActive) {
        void loadSubagentMonitor(host as unknown as Parameters<typeof loadSubagentMonitor>[0], {
          quiet: true,
        });
      }
    }
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as OpenClawApp, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSnapshot;
        sessionDefaults?: SessionDefaultsSnapshot;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}
