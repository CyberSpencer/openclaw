import type { OpenClawConfig } from "../config/config.js";
import { emitDiagnosticObservabilityEvent } from "../logging/observability.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
};

export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};

export type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};

export type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};

export type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
  type: "message.queued";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  source: string;
  queueDepth?: number;
};

export type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

export type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
  type: "session.state";
  sessionKey?: string;
  sessionId?: string;
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};

export type DiagnosticSessionStuckEvent = DiagnosticBaseEvent & {
  type: "session.stuck";
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
};

export type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};

export type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};

export type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
  type: "run.attempt";
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
};

export type DiagnosticModelResolveEvent = DiagnosticBaseEvent & {
  type: "model.resolve";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  channel?: string;
  provider: string;
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  resolution:
    | "registry"
    | "inline-config"
    | "forward-compat"
    | "openrouter-pass-through"
    | "provider-config"
    | "provider-base-url-override";
  baseUrl?: string;
};

export type DiagnosticModelRequestEvent = DiagnosticBaseEvent & {
  type: "model.request";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  channel?: string;
  provider: string;
  model: string;
  requestIndex?: number;
  historyMessages?: number;
  imageCount?: number;
};

export type DiagnosticModelResultEvent = DiagnosticBaseEvent & {
  type: "model.result";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  requestIndex?: number;
  status: "ok" | "error";
  durationMs?: number;
  error?: string;
  stopReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
};

export type DiagnosticToolCallEvent = DiagnosticBaseEvent & {
  type: "tool.call";
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId: string;
  phase: "start" | "result";
  summary?: string;
  status?: "ok" | "error";
  durationMs?: number;
  meta?: string;
};

export type DiagnosticSkillExecutionEvent = DiagnosticBaseEvent & {
  type: "skill.execution";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  channel?: string;
  source: "snapshot" | "workspace" | "slash-command";
  phase: "prepare" | "start" | "result";
  status?: "ok" | "error";
  skillCount?: number;
  skillNames?: string[];
  skillName?: string;
  commandName?: string;
  toolName?: string;
  argChars?: number;
  durationMs?: number;
  error?: string;
};

export type DiagnosticSubagentLifecycleEvent = DiagnosticBaseEvent & {
  type: "subagent.lifecycle";
  requesterSessionKey?: string;
  requesterSourceSessionKey?: string;
  childSessionKey: string;
  runId: string;
  phase: "spawn_failed" | "registered" | "wait_started" | "wait_result";
  status?: "ok" | "error" | "timeout";
  cleanup?: "delete" | "keep";
  mode?: "run" | "session";
  label?: string;
  model?: string;
  modelApplied?: boolean;
  routing?: string;
  taskChars?: number;
  runTimeoutSeconds?: number;
  durationMs?: number;
  error?: string;
};

export type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
};

export type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
};

export type DiagnosticEventPayload =
  | DiagnosticUsageEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticModelResolveEvent
  | DiagnosticModelRequestEvent
  | DiagnosticModelResultEvent
  | DiagnosticToolCallEvent
  | DiagnosticSkillExecutionEvent
  | DiagnosticSubagentLifecycleEvent
  | DiagnosticHeartbeatEvent
  | DiagnosticToolLoopEvent;

export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, "seq" | "ts">
    : never
  : never;

type DiagnosticEventsGlobalState = {
  seq: number;
  listeners: Set<(evt: DiagnosticEventPayload) => void>;
  dispatchDepth: number;
};

function getDiagnosticEventsState(): DiagnosticEventsGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticEventsState?: DiagnosticEventsGlobalState;
  };
  if (!globalStore.__openclawDiagnosticEventsState) {
    globalStore.__openclawDiagnosticEventsState = {
      seq: 0,
      listeners: new Set<(evt: DiagnosticEventPayload) => void>(),
      dispatchDepth: 0,
    };
  }
  return globalStore.__openclawDiagnosticEventsState;
}

export function isDiagnosticsEnabled(config?: OpenClawConfig): boolean {
  return config?.diagnostics?.enabled === true;
}

export function emitDiagnosticEvent(event: DiagnosticEventInput) {
  const state = getDiagnosticEventsState();
  if (state.dispatchDepth > 100) {
    console.error(
      `[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${event.type}`,
    );
    return;
  }

  const enriched = {
    ...event,
    seq: (state.seq += 1),
    ts: Date.now(),
  } satisfies DiagnosticEventPayload;
  try {
    emitDiagnosticObservabilityEvent(enriched);
  } catch {
    // Never block runtime event dispatch on observability sink failures.
  }
  state.dispatchDepth += 1;
  for (const listener of state.listeners) {
    try {
      listener(enriched);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? (err.stack ?? err.message)
          : typeof err === "string"
            ? err
            : String(err);
      console.error(
        `[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`,
      );
      // Ignore listener failures.
    }
  }
  state.dispatchDepth -= 1;
}

export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  const state = getDiagnosticEventsState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function resetDiagnosticEventsForTest(): void {
  const state = getDiagnosticEventsState();
  state.seq = 0;
  state.listeners.clear();
  state.dispatchDepth = 0;
}
