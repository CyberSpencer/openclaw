import type { GatewayHost } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettings,
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { normalizeBasePath } from "./navigation.ts";

type LifecycleHost = GatewayHost & {
  chatManualRefreshInFlight: boolean;
  logsAutoFollow: boolean;
  popStateHandler: () => void;
  connect: () => void;
};

function normalizeGatewayUrl(url: string): string {
  const raw = url.trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return raw;
  }
}

function resolveLocalGatewayUrl(basePath: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const normalizedBasePath = normalizeBasePath(basePath);
  return `${proto}//${window.location.host}${normalizedBasePath}`;
}

function maybeApplyBootstrapGatewayToken(
  host: LifecycleHost,
  token: string,
  bootstrapBasePath: string,
) {
  const nextToken = token.trim();
  if (!nextToken) {
    return;
  }
  const localGatewayUrl = resolveLocalGatewayUrl(bootstrapBasePath || host.basePath);
  const configuredGatewayUrl = host.settings.gatewayUrl.trim();
  const effectiveGatewayUrl = configuredGatewayUrl || localGatewayUrl;
  if (normalizeGatewayUrl(effectiveGatewayUrl) !== normalizeGatewayUrl(localGatewayUrl)) {
    return;
  }
  if (host.settings.token === nextToken && configuredGatewayUrl === effectiveGatewayUrl) {
    return;
  }
  applySettings(host, {
    ...host.settings,
    gatewayUrl: effectiveGatewayUrl,
    token: nextToken,
  });
}

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  applySettingsFromUrl(host);
  syncTabWithLocation(host, true);
  syncThemeWithSettings(host);
  attachThemeListener(host);
  window.addEventListener("popstate", host.popStateHandler);
  void loadControlUiBootstrapConfig(host, {
    onGatewayAuthToken: (token, bootstrapBasePath) =>
      maybeApplyBootstrapGatewayToken(host, token, bootstrapBasePath),
  }).finally(() => {
    host.connect();
  });
  startNodesPolling(host);
  if (host.tab === "logs") {
    startLogsPolling(host);
  }
  if (host.tab === "debug") {
    startDebugPolling(host);
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host);
  stopLogsPolling(host);
  stopDebugPolling(host);
  const client = host.client as { stop?: () => void } | null | undefined;
  if (typeof client?.stop === "function") {
    client.stop();
  }
  host.client = null;
  host.connected = false;
  detachThemeListener(host);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(host, forcedByTab || forcedByLoad || !host.chatHasAutoScrolled);
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(host, changed.has("tab") || changed.has("logsAutoFollow"));
    }
  }
}
