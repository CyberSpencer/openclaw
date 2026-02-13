import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";

type SessionsSubagentsResponse = {
  ts?: number;
  tasks?: Array<{
    childSessionKey?: string;
    label?: string;
    task?: string;
    runId?: string;
    status?: "running" | "done" | "error";
    createdAt?: number;
    startedAt?: number;
    endedAt?: number;
    model?: string;
  }>;
};

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
      requesterSessionKey: spawnedBy,
      includeCompleted: true,
    };
    const limit = typeof opts?.limit === "number" ? opts.limit : 20;
    if (limit > 0) {
      params.limit = limit;
    }

    const res = await state.client.request<SessionsSubagentsResponse>("sessions.subagents", params);
    const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
    const sessions = tasks
      .map((task) => {
        const key = typeof task.childSessionKey === "string" ? task.childSessionKey.trim() : "";
        if (!key) {
          return null;
        }
        const updatedAt =
          typeof task.endedAt === "number"
            ? task.endedAt
            : typeof task.startedAt === "number"
              ? task.startedAt
              : typeof task.createdAt === "number"
                ? task.createdAt
                : null;
        const status = typeof task.status === "string" ? task.status : "running";
        const preview =
          status === "error"
            ? `Failed: ${(typeof task.task === "string" ? task.task : "subagent task").trim()}`
            : typeof task.task === "string"
              ? task.task.trim()
              : "";
        return {
          key,
          kind: "direct" as const,
          label: typeof task.label === "string" ? task.label : undefined,
          derivedTitle: typeof task.task === "string" ? task.task : undefined,
          displayName: typeof task.label === "string" ? task.label : undefined,
          lastMessagePreview: preview || undefined,
          updatedAt,
          sessionId: typeof task.runId === "string" ? task.runId : undefined,
          model: typeof task.model === "string" ? task.model : undefined,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    state.subagentMonitorResult = {
      ts: typeof res?.ts === "number" ? res.ts : Date.now(),
      path: "(subagents)",
      count: sessions.length,
      defaults: {
        modelProvider: null,
        model: null,
        contextTokens: null,
      },
      sessions,
    };
    state.subagentMonitorError = null;
  } catch (primaryErr) {
    try {
      const legacyParams: Record<string, unknown> = {
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: true,
        spawnedBy,
      };
      const limit = typeof opts?.limit === "number" ? opts.limit : 20;
      if (limit > 0) {
        legacyParams.limit = limit;
      }
      const legacy = await state.client.request<SessionsListResult>("sessions.list", legacyParams);
      state.subagentMonitorResult = legacy ?? null;
      state.subagentMonitorError = null;
    } catch (fallbackErr) {
      state.subagentMonitorError = `${String(primaryErr)}; fallback failed: ${String(fallbackErr)}`;
    }
  } finally {
    state.subagentMonitorLoading = false;
  }
}
