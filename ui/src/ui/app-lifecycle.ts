import { connectGateway, type GatewayHost } from "./app-gateway.ts";
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
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";

type LifecycleHost = GatewayHost & {
  chatManualRefreshInFlight: boolean;
  logsAutoFollow: boolean;
  popStateHandler: () => void;
};

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  applySettingsFromUrl(host);
  syncTabWithLocation(host, true);
  syncThemeWithSettings(host);
  attachThemeListener(host);
  window.addEventListener("popstate", host.popStateHandler);
  connectGateway(host);
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
