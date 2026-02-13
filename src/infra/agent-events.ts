import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  rootConversationId?: string;
  threadId?: string;
  parentRunId?: string;
  subagentGroupId?: string;
  taskId?: string;
  requesterSessionKey?: string;
  spawnedBySessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  rootConversationId?: string;
  threadId?: string;
  parentRunId?: string;
  subagentGroupId?: string;
  taskId?: string;
  requesterSessionKey?: string;
  spawnedBySessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.rootConversationId && existing.rootConversationId !== context.rootConversationId) {
    existing.rootConversationId = context.rootConversationId;
  }
  if (context.threadId && existing.threadId !== context.threadId) {
    existing.threadId = context.threadId;
  }
  if (context.parentRunId && existing.parentRunId !== context.parentRunId) {
    existing.parentRunId = context.parentRunId;
  }
  if (context.subagentGroupId && existing.subagentGroupId !== context.subagentGroupId) {
    existing.subagentGroupId = context.subagentGroupId;
  }
  if (context.taskId && existing.taskId !== context.taskId) {
    existing.taskId = context.taskId;
  }
  if (context.requesterSessionKey && existing.requesterSessionKey !== context.requesterSessionKey) {
    existing.requesterSessionKey = context.requesterSessionKey;
  }
  if (context.spawnedBySessionKey && existing.spawnedBySessionKey !== context.spawnedBySessionKey) {
    existing.spawnedBySessionKey = context.spawnedBySessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const rootConversationId =
    typeof event.rootConversationId === "string" && event.rootConversationId.trim()
      ? event.rootConversationId
      : context?.rootConversationId;
  const threadId =
    typeof event.threadId === "string" && event.threadId.trim()
      ? event.threadId
      : context?.threadId;
  const parentRunId =
    typeof event.parentRunId === "string" && event.parentRunId.trim()
      ? event.parentRunId
      : context?.parentRunId;
  const subagentGroupId =
    typeof event.subagentGroupId === "string" && event.subagentGroupId.trim()
      ? event.subagentGroupId
      : context?.subagentGroupId;
  const taskId =
    typeof event.taskId === "string" && event.taskId.trim() ? event.taskId : context?.taskId;
  const requesterSessionKey =
    typeof event.requesterSessionKey === "string" && event.requesterSessionKey.trim()
      ? event.requesterSessionKey
      : context?.requesterSessionKey;
  const spawnedBySessionKey =
    typeof event.spawnedBySessionKey === "string" && event.spawnedBySessionKey.trim()
      ? event.spawnedBySessionKey
      : context?.spawnedBySessionKey;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    rootConversationId,
    threadId,
    parentRunId,
    subagentGroupId,
    taskId,
    requesterSessionKey,
    spawnedBySessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
