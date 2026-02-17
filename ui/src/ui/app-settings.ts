import { refreshChat, type ChatHost } from "./app-chat.ts";
import {
  startDebugPolling,
  startLogsPolling,
  stopDebugPolling,
  stopLogsPolling,
  type PollingHost,
} from "./app-polling.ts";
import { scheduleChatScroll, scheduleLogsScroll, type ScrollHost } from "./app-scroll.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
import { loadChannels, type ChannelsState } from "./controllers/channels.ts";
import { loadConfig, loadConfigSchema, type ConfigState } from "./controllers/config.ts";
import { loadCronJobs, loadCronStatus, type CronState } from "./controllers/cron.ts";
import { loadDebug, type DebugState } from "./controllers/debug.ts";
import { loadDevices, type DevicesState } from "./controllers/devices.ts";
import { loadExecApprovals, type ExecApprovalsState } from "./controllers/exec-approvals.ts";
import { loadLogs, type LogsState } from "./controllers/logs.ts";
import { loadNodes, type NodesState } from "./controllers/nodes.ts";
import { loadPresence, type PresenceState } from "./controllers/presence.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
import { loadSkills, type SkillsState } from "./controllers/skills.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation.ts";
import { saveSettings, type UiSettings } from "./storage.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme.ts";

export type SettingsHost = PollingHost &
  ScrollHost &
  ChatHost &
  AgentsState &
  ChannelsState &
  ConfigState &
  CronState &
  DebugState &
  DevicesState &
  ExecApprovalsState &
  LogsState &
  NodesState &
  PresenceState &
  SessionsState &
  SkillsState & {
    settings: UiSettings;
    password?: string;
    theme: ThemeMode;
    themeResolved: ResolvedTheme;
    applySessionKey: string;
    tab: Tab;
    eventLog: unknown[];
    eventLogBuffer: unknown[];
    basePath: string;
    agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
    themeMedia: MediaQueryList | null;
    themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
    pendingGatewayUrl?: string | null;
    refreshTopbarControls?: () => Promise<void> | void;
  };

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme) {
    host.theme = next.theme;
    applyResolvedTheme(host, resolveTheme(next.theme));
  }
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export type LastActiveSessionHost = Pick<SettingsHost, "settings" | "applySessionKey">;

export function setLastActiveSessionKey(host: LastActiveSessionHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) {
    return;
  }
  if (host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  host.settings = { ...host.settings, lastActiveSessionKey: trimmed };
  saveSettings(host.settings);
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function applySettingsFromUrl(host: SettingsHost) {
  const params = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash ? window.location.hash.replace(/^#/, "") : "";
  const hashParams =
    hashRaw && /[=&]/.test(hashRaw) && !hashRaw.startsWith("/")
      ? new URLSearchParams(hashRaw)
      : null;

  const tokenRaw = params.get("token") ?? hashParams?.get("token") ?? null;
  const passwordRaw = params.get("password") ?? hashParams?.get("password") ?? null;
  const sessionRaw = params.get("session") ?? hashParams?.get("session") ?? null;
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams?.get("gatewayUrl") ?? null;
  let shouldCleanUrl = false;

  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    params.delete("token");
    hashParams?.delete("token");
    shouldCleanUrl = true;
  }

  if (passwordRaw != null) {
    const password = passwordRaw.trim();
    if (password) {
      (host as { password: string }).password = password;
    }
    params.delete("password");
    hashParams?.delete("password");
    shouldCleanUrl = true;
  }

  if (sessionRaw != null) {
    const session = sessionRaw.trim();
    if (session) {
      host.sessionKey = session;
      applySettings(host, {
        ...host.settings,
        sessionKey: session,
        lastActiveSessionKey: session,
      });
    }
  }

  if (gatewayUrlRaw != null) {
    const gatewayUrl = gatewayUrlRaw.trim();
    if (gatewayUrl && gatewayUrl !== host.settings.gatewayUrl) {
      host.pendingGatewayUrl = gatewayUrl;
    }
    params.delete("gatewayUrl");
    hashParams?.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) {
    return;
  }
  const url = new URL(window.location.href);
  url.search = params.toString();
  if (hashParams) {
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  if (host.tab !== next) {
    host.tab = next;
  }
  if (next === "chat") {
    host.chatHasAutoScrolled = false;
  }
  if (next === "logs") {
    startLogsPolling(host);
  } else {
    stopLogsPolling(host);
  }
  if (next === "debug") {
    startDebugPolling(host);
  } else {
    stopDebugPolling(host);
  }
  void refreshActiveTab(host);
  syncUrlWithTab(host, next, false);
}

export function setTheme(host: SettingsHost, next: ThemeMode, context?: ThemeTransitionContext) {
  const applyTheme = () => {
    host.theme = next;
    applySettings(host, { ...host.settings, theme: next });
    applyResolvedTheme(host, resolveTheme(next));
  };
  startThemeTransition({
    nextTheme: next,
    applyTheme,
    context,
    currentTheme: host.theme,
  });
}

export async function refreshActiveTab(host: SettingsHost) {
  if (host.tab === "overview") {
    await loadOverview(host);
  }
  if (host.tab === "orchestrator") {
    await loadAgents(host);
  }
  if (host.tab === "settings") {
    await host.refreshTopbarControls?.();
  }
  if (host.tab === "channels") {
    await loadChannelsTab(host);
  }
  if (host.tab === "instances") {
    await loadPresence(host);
  }
  if (host.tab === "sessions") {
    await loadSessions(host);
  }
  if (host.tab === "cron") {
    await loadCron(host);
  }
  if (host.tab === "skills") {
    await loadSkills(host);
  }
  if (host.tab === "nodes") {
    await loadNodes(host);
    await loadDevices(host);
    await loadConfig(host);
    await loadExecApprovals(host);
  }
  if (host.tab === "chat") {
    await refreshChat(host);
    scheduleChatScroll(host, !host.chatHasAutoScrolled);
  }
  if (host.tab === "config") {
    await loadConfigSchema(host);
    await loadConfig(host);
  }
  if (host.tab === "debug") {
    await loadDebug(host);
    host.eventLog = host.eventLogBuffer;
  }
  if (host.tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host, { reset: true });
    scheduleLogsScroll(host, true);
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const configured = window.__OPENCLAW_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "system";
  applyResolvedTheme(host, resolveTheme(host.theme));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Keep a `.dark` class in sync so utility ecosystems (including shadcn presets)
  // can key off it without changing our existing `[data-theme]` selectors.
  root.classList.toggle("dark", resolved === "dark");
}

export function attachThemeListener(host: SettingsHost) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  host.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  host.themeMediaHandler = (event) => {
    if (host.theme !== "system") {
      return;
    }
    applyResolvedTheme(host, event.matches ? "dark" : "light");
  };
  if (typeof host.themeMedia.addEventListener === "function") {
    host.themeMedia.addEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(host.themeMediaHandler);
}

export function detachThemeListener(host: SettingsHost) {
  if (!host.themeMedia || !host.themeMediaHandler) {
    return;
  }
  if (typeof host.themeMedia.removeEventListener === "function") {
    host.themeMedia.removeEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.removeListener(host.themeMediaHandler);
  host.themeMedia = null;
  host.themeMediaHandler = null;
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath) ?? "chat";
  setTabFromRoute(host, resolved);
  syncUrlWithTab(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) {
    return;
  }

  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  setTabFromRoute(host, resolved);
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  if (host.tab !== next) {
    host.tab = next;
  }
  if (next === "chat") {
    host.chatHasAutoScrolled = false;
  }
  if (next === "logs") {
    startLogsPolling(host);
  } else {
    stopLogsPolling(host);
  }
  if (next === "debug") {
    startDebugPolling(host);
  } else {
    stopDebugPolling(host);
  }
  if (host.connected) {
    void refreshActiveTab(host);
  }
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(host: SettingsHost, sessionKey: string, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export async function loadOverview(host: SettingsHost) {
  await Promise.all([
    loadChannels(host, false),
    loadPresence(host),
    loadSessions(host),
    loadCronStatus(host),
    loadDebug(host),
  ]);
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([loadChannels(host, true), loadConfigSchema(host), loadConfig(host)]);
}

export async function loadCron(host: SettingsHost) {
  await Promise.all([loadChannels(host, false), loadCronStatus(host), loadCronJobs(host)]);
}
