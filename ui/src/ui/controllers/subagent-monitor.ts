import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionListEntry, SessionsListResult } from "../types.ts";

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
    modelProvider?: string;
    modelApplied?: boolean;
    routing?: string;
    complexity?: string;
    outcome?: { status?: string; error?: string };
    runtimeMs?: number;
    source?: "subagent" | "background-exec";
    openable?: boolean;
    spawnMode?: "run" | "session";
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

const OMITTED_RUNNING_ROW_GRACE_MS = 5_000;

function mergeMonitorRow(next: SessionListEntry, prev?: SessionListEntry): SessionListEntry {
  if (!prev) {
    return next;
  }
  return {
    ...next,
    sessionId: next.sessionId || prev.sessionId,
    lastMessagePreview: next.lastMessagePreview || prev.lastMessagePreview,
    updatedAt: next.updatedAt ?? prev.updatedAt,
    label: next.label || prev.label,
    derivedTitle: next.derivedTitle || prev.derivedTitle,
    displayName: next.displayName || prev.displayName,
    model: next.model || prev.model,
    modelProvider: next.modelProvider || prev.modelProvider,
    modelApplied: next.modelApplied ?? prev.modelApplied,
    routing: next.routing || prev.routing,
    complexity: next.complexity || prev.complexity,
    runStatus: next.runStatus || prev.runStatus,
    createdAt: next.createdAt ?? prev.createdAt,
    startedAt: next.startedAt ?? prev.startedAt,
    endedAt: next.endedAt ?? prev.endedAt,
    runtimeMs: next.runtimeMs ?? prev.runtimeMs,
    outcome: next.outcome ?? prev.outcome,
    task: next.task || prev.task,
    source: next.source ?? prev.source,
    openable: next.openable ?? prev.openable,
    spawnMode: next.spawnMode ?? prev.spawnMode,
  } satisfies SessionListEntry;
}

function isRunningRow(row?: { runStatus?: string } | null): boolean {
  return (row?.runStatus ?? "").trim().toLowerCase() === "running";
}

export async function loadSubagentMonitor(
  state: SubagentMonitorState,
  opts?: { limit?: number; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  // Always gate on loading to prevent concurrent polls racing each other.
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

  const limit = typeof opts?.limit === "number" ? opts.limit : 20;

  try {
    // Fetch both sources in parallel every time.
    // sessions.subagents → live status (runStatus, runtimeMs, outcome, source, spawnMode)
    // sessions.list      → display data (lastMessagePreview, updatedAt, label)
    // Merging eliminates the primary/fallback oscillation that caused the flicker.
    const [subagentsRes, listRes] = await Promise.allSettled([
      state.client.request<SessionsSubagentsResponse>("sessions.subagents", {
        requesterSessionKey: spawnedBy,
        includeCompleted: true,
        ...(limit > 0 ? { limit } : {}),
      }),
      state.client.request<SessionsListResult>("sessions.list", {
        spawnedBy,
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: true,
        ...(limit > 0 ? { limit } : {}),
      }),
    ]);

    // Build display-data lookup from sessions.list.
    const listByKey = new Map<string, SessionListEntry>();
    if (listRes.status === "fulfilled" && Array.isArray(listRes.value?.sessions)) {
      for (const s of listRes.value.sessions) {
        if (s.key) {
          listByKey.set(s.key, s);
        }
      }
    }

    let sessions: SessionListEntry[] = [];

    if (subagentsRes.status === "fulfilled") {
      const tasks = Array.isArray(subagentsRes.value?.tasks) ? subagentsRes.value.tasks : [];
      sessions = tasks
        .map((task) => {
          const source = task.source === "background-exec" ? "background-exec" : "subagent";
          const rawKey =
            typeof task.childSessionKey === "string" ? task.childSessionKey.trim() : "";
          const runId = typeof task.runId === "string" ? task.runId.trim() : "";
          const key = rawKey || (source === "background-exec" && runId ? `process:${runId}` : "");
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
          const taskStr = typeof task.task === "string" ? task.task.trim() : "";

          // Prefer display data from sessions.list — it has actual message previews
          // and reliable timestamps. Fall back to task data only when list has nothing.
          const listEntry = listByKey.get(key);
          const preview =
            listEntry?.lastMessagePreview?.trim() ||
            (status === "error" ? `Failed: ${taskStr || "subagent task"}` : taskStr);

          return {
            key,
            kind: "direct" as const,
            label: (typeof task.label === "string" ? task.label : undefined) || listEntry?.label,
            derivedTitle: taskStr || listEntry?.derivedTitle,
            displayName:
              (typeof task.label === "string" ? task.label : undefined) || listEntry?.displayName,
            lastMessagePreview: preview || undefined,
            updatedAt: updatedAt ?? listEntry?.updatedAt ?? null,
            sessionId: runId || undefined,
            model: (typeof task.model === "string" ? task.model : undefined) || listEntry?.model,
            modelProvider:
              (typeof task.modelProvider === "string" ? task.modelProvider : undefined) ||
              listEntry?.modelProvider,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            runStatus: status,
            createdAt: typeof task.createdAt === "number" ? task.createdAt : listEntry?.createdAt,
            startedAt: typeof task.startedAt === "number" ? task.startedAt : listEntry?.startedAt,
            endedAt: typeof task.endedAt === "number" ? task.endedAt : listEntry?.endedAt,
            runtimeMs: typeof task.runtimeMs === "number" ? task.runtimeMs : listEntry?.runtimeMs,
            modelApplied: task.modelApplied === true,
            routing:
              (typeof task.routing === "string" ? task.routing : undefined) || listEntry?.routing,
            complexity:
              (typeof task.complexity === "string" ? task.complexity : undefined) ||
              listEntry?.complexity,
            outcome: task.outcome && typeof task.outcome === "object" ? task.outcome : undefined,
            task: taskStr || undefined,
            source,
            openable: task.openable !== false,
            spawnMode:
              task.spawnMode === "session"
                ? "session"
                : task.spawnMode === "run"
                  ? "run"
                  : undefined,
          } satisfies SessionListEntry;
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
    } else if (listRes.status === "fulfilled" && Array.isArray(listRes.value?.sessions)) {
      // subagents endpoint failed entirely — use sessions.list directly.
      sessions = listRes.value.sessions;
    }

    // Merge with previously-shown data so display fields are never lost between polls.
    const prevSessions = state.subagentMonitorResult?.sessions ?? [];
    const prevByKey = new Map(prevSessions.map((s) => [s.key, s]));
    const mergedSessions: SessionListEntry[] = [];
    const seenKeys = new Set<string>();
    const pushMerged = (row: SessionListEntry) => {
      const key = row.key?.trim();
      if (!key || seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      mergedSessions.push(mergeMonitorRow(row, prevByKey.get(key)));
    };

    for (const session of sessions) {
      pushMerged(session);
    }

    if (subagentsRes.status === "fulfilled" && listRes.status === "fulfilled") {
      const listSessions = Array.isArray(listRes.value?.sessions) ? listRes.value.sessions : [];
      for (const listEntry of listSessions) {
        const prev = prevByKey.get(listEntry.key);
        if (!prev) {
          continue;
        }
        pushMerged(listEntry);
      }
    }

    const previousPollTs =
      typeof state.subagentMonitorResult?.ts === "number" ? state.subagentMonitorResult.ts : 0;
    const preserveOmittedRunningRows =
      subagentsRes.status === "fulfilled" &&
      Date.now() - previousPollTs <= OMITTED_RUNNING_ROW_GRACE_MS;
    if (preserveOmittedRunningRows) {
      for (const prev of prevSessions) {
        if (!isRunningRow(prev)) {
          continue;
        }
        pushMerged(prev);
      }
    }

    // Only write state when something meaningful changed to avoid spurious re-renders.
    const changed =
      prevSessions.length !== mergedSessions.length ||
      mergedSessions.some((n) => {
        const p = prevByKey.get(n.key);
        return (
          !p ||
          p.runStatus !== n.runStatus ||
          p.startedAt !== n.startedAt ||
          p.endedAt !== n.endedAt ||
          p.runtimeMs !== n.runtimeMs ||
          p.lastMessagePreview !== n.lastMessagePreview ||
          p.updatedAt !== n.updatedAt ||
          p.outcome?.status !== n.outcome?.status ||
          p.outcome?.error !== n.outcome?.error
        );
      });

    if (changed) {
      const ts =
        subagentsRes.status === "fulfilled" && typeof subagentsRes.value?.ts === "number"
          ? subagentsRes.value.ts
          : Date.now();
      state.subagentMonitorResult = {
        ts,
        path: "(subagents)",
        count: mergedSessions.length,
        total: mergedSessions.length,
        limit: mergedSessions.length,
        offset: 0,
        hasMore: false,
        nextOffset: null,
        defaults: { model: null, contextTokens: null },
        sessions: mergedSessions,
      };
    }
    state.subagentMonitorError = null;
  } catch (err) {
    if (!opts?.quiet) {
      state.subagentMonitorError = String(err);
    }
  } finally {
    state.subagentMonitorLoading = false;
  }
}
