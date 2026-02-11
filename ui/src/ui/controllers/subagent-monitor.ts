import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";

export type SubagentMonitorState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Session key whose spawned subagents we want to list. */
  sessionKey: string;
  subagentMonitorLoading: boolean;
  subagentMonitorResult: SessionsListResult | null;
  subagentMonitorError: string | null;
};

export async function loadSubagentMonitor(
  state: SubagentMonitorState,
  opts?: { limit?: number; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.subagentMonitorLoading) {
    return;
  }

  const spawnedBy = (state.sessionKey ?? "").trim();
  if (!spawnedBy) {
    return;
  }

  state.subagentMonitorLoading = true;
  if (!opts?.quiet) {
    state.subagentMonitorError = null;
  }
  try {
    const params: Record<string, unknown> = {
      includeGlobal: false,
      includeUnknown: false,
      // Derived titles require transcript reads. Subagents already have labels,
      // so keep this off to reduce churn while polling.
      includeDerivedTitles: false,
      includeLastMessage: true,
      spawnedBy,
    };
    const limit = typeof opts?.limit === "number" ? opts.limit : 20;
    if (limit > 0) {
      params.limit = limit;
    }

    const res = await state.client.request("sessions.list", params);
    state.subagentMonitorResult = res ?? null;
  } catch (err) {
    state.subagentMonitorError = String(err);
  } finally {
    state.subagentMonitorLoading = false;
  }
}
