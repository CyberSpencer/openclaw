const KEY = "openclaw.control.settings.v1";

import { inferBasePathFromPathname, normalizeBasePath } from "./navigation.ts";
import type { ThemeMode } from "./theme.ts";

function unbracketHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  const value = unbracketHostname(hostname);
  if (value === "localhost" || value === "127.0.0.1" || value === "::1") {
    return true;
  }
  if (value.startsWith("::ffff:")) {
    return value.slice("::ffff:".length) === "127.0.0.1";
  }
  return false;
}

export function alignLoopbackGatewayUrlWithDocument(
  gatewayUrl: string,
  documentHost: string,
  documentHostname: string,
): string {
  const trimmed = (gatewayUrl ?? "").trim();
  const docHost = (documentHost ?? "").trim();
  const docHostname = (documentHostname ?? "").trim();
  if (!trimmed || !docHost || !docHostname) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return trimmed;
    }
    if (!isLoopbackHostname(parsed.hostname) || !isLoopbackHostname(docHostname)) {
      return trimmed;
    }
    if (parsed.host.toLowerCase() === docHost.toLowerCase()) {
      return trimmed;
    }
    parsed.host = docHost;
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  voiceMixedModeEnabled: boolean;
  voiceSpokenOutputMode: "concise" | "full" | "status";
  voiceAutoApproveOnce: boolean;
  voiceApprovalPolicyMode: "strict";
  // Spark TTS steering (persisted per-browser)
  ttsVoice: string; // Speaker identity, "" = backend default (Ryan)
  ttsInstruct: string; // Mood/style instruction, "" = none
  ttsLanguage: string; // Language hint, "" = Auto
};

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const configuredBasePath =
      typeof window !== "undefined" &&
      typeof (window as { __OPENCLAW_CONTROL_UI_BASE_PATH__?: unknown })
        .__OPENCLAW_CONTROL_UI_BASE_PATH__ === "string"
        ? (
            window as {
              __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
            }
          ).__OPENCLAW_CONTROL_UI_BASE_PATH__?.trim()
        : "";
    const basePath = configuredBasePath
      ? normalizeBasePath(configuredBasePath)
      : inferBasePathFromPathname(location.pathname);
    return `${proto}://${location.host}${basePath}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "dark",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    voiceMixedModeEnabled: true,
    voiceSpokenOutputMode: "concise",
    voiceAutoApproveOnce: true,
    voiceApprovalPolicyMode: "strict",
    ttsVoice: "",
    ttsInstruct: "Speak warmly and calmly",
    ttsLanguage: "",
  };

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return {
        ...defaults,
        gatewayUrl: alignLoopbackGatewayUrlWithDocument(
          defaults.gatewayUrl,
          location.host,
          location.hostname,
        ),
      };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const parsedTheme = (parsed as { theme?: unknown }).theme;
    const mergedGatewayUrl =
      typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
        ? parsed.gatewayUrl.trim()
        : defaults.gatewayUrl;
    return {
      gatewayUrl: alignLoopbackGatewayUrlWithDocument(
        mergedGatewayUrl,
        location.host,
        location.hostname,
      ),
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsedTheme === "light" || parsedTheme === "dark"
          ? parsedTheme
          : parsedTheme === "system" ||
              parsedTheme === "openknot" ||
              parsedTheme === "fieldmanual" ||
              parsedTheme === "clawdash"
            ? "dark"
            : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      voiceMixedModeEnabled:
        typeof parsed.voiceMixedModeEnabled === "boolean"
          ? parsed.voiceMixedModeEnabled
          : defaults.voiceMixedModeEnabled,
      voiceSpokenOutputMode:
        parsed.voiceSpokenOutputMode === "concise" ||
        parsed.voiceSpokenOutputMode === "full" ||
        parsed.voiceSpokenOutputMode === "status"
          ? parsed.voiceSpokenOutputMode
          : defaults.voiceSpokenOutputMode,
      voiceAutoApproveOnce:
        typeof parsed.voiceAutoApproveOnce === "boolean"
          ? parsed.voiceAutoApproveOnce
          : defaults.voiceAutoApproveOnce,
      voiceApprovalPolicyMode:
        parsed.voiceApprovalPolicyMode === "strict"
          ? parsed.voiceApprovalPolicyMode
          : defaults.voiceApprovalPolicyMode,
      ttsVoice: typeof parsed.ttsVoice === "string" ? parsed.ttsVoice.trim() : defaults.ttsVoice,
      ttsInstruct:
        typeof parsed.ttsInstruct === "string" ? parsed.ttsInstruct.trim() : defaults.ttsInstruct,
      ttsLanguage:
        typeof parsed.ttsLanguage === "string" ? parsed.ttsLanguage.trim() : defaults.ttsLanguage,
    };
  } catch {
    return {
      ...defaults,
      gatewayUrl: alignLoopbackGatewayUrlWithDocument(
        defaults.gatewayUrl,
        location.host,
        location.hostname,
      ),
    };
  }
}

export function saveSettings(next: UiSettings) {
  const gatewayUrl =
    typeof location !== "undefined"
      ? alignLoopbackGatewayUrlWithDocument(next.gatewayUrl, location.host, location.hostname)
      : next.gatewayUrl;
  localStorage.setItem(KEY, JSON.stringify({ ...next, gatewayUrl }));
}
