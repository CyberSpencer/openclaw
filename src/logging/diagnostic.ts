import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  getDiagnosticSessionStateCountForTest as getDiagnosticSessionStateCountForTestImpl,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
  type SessionRef,
  type SessionStateValue,
} from "./diagnostic-session-state.js";
import { createSubsystemLogger } from "./subsystem.js";

const diag = createSubsystemLogger("diagnostic");

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};

let lastActivityAt = 0;
const DEFAULT_STUCK_SESSION_WARN_MS = 120_000;
const MIN_STUCK_SESSION_WARN_MS = 1_000;
const MAX_STUCK_SESSION_WARN_MS = 24 * 60 * 60 * 1000;

function markActivity() {
  lastActivityAt = Date.now();
}

export function resolveStuckSessionWarnMs(config?: OpenClawConfig): number {
  const raw = config?.diagnostics?.stuckSessionWarnMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  const rounded = Math.floor(raw);
  if (rounded < MIN_STUCK_SESSION_WARN_MS || rounded > MAX_STUCK_SESSION_WARN_MS) {
    return DEFAULT_STUCK_SESSION_WARN_MS;
  }
  return rounded;
}

export function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}) {
  webhookStats.received += 1;
  webhookStats.lastReceived = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
        params.chatId ?? "unknown"
      } total=${webhookStats.received}`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.received",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
  });
  markActivity();
}

export function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}) {
  webhookStats.processed += 1;
  if (diag.isEnabled("debug")) {
    diag.debug(
      `webhook processed: channel=${params.channel} type=${
        params.updateType ?? "unknown"
      } chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${
        webhookStats.processed
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "webhook.processed",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    durationMs: params.durationMs,
  });
  markActivity();
}

export function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}) {
  webhookStats.errors += 1;
  diag.error(
    `webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } error="${params.error}" errors=${webhookStats.errors}`,
  );
  emitDiagnosticEvent({
    type: "webhook.error",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    error: params.error,
  });
  markActivity();
}

export function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}) {
  const state = getDiagnosticSessionState(params);
  state.queueDepth += 1;
  state.lastActivity = Date.now();
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}) {
  const wantsLog = params.outcome === "error" ? diag.isEnabled("error") : diag.isEnabled("debug");
  if (wantsLog) {
    const payload = `message processed: channel=${params.channel} chatId=${
      params.chatId ?? "unknown"
    } messageId=${params.messageId ?? "unknown"} sessionId=${
      params.sessionId ?? "unknown"
    } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${
      params.durationMs ?? 0
    }ms${params.reason ? ` reason=${params.reason}` : ""}${
      params.error ? ` error="${params.error}"` : ""
    }`;
    if (params.outcome === "error") {
      diag.error(payload);
    } else {
      diag.debug(payload);
    }
  }
  emitDiagnosticEvent({
    type: "message.processed",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    durationMs: params.durationMs,
    outcome: params.outcome,
    reason: params.reason,
    error: params.error,
  });
  markActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
  },
) {
  const state = getDiagnosticSessionState(params);
  const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
  const prevState = state.state;
  state.state = params.state;
  state.lastActivity = Date.now();
  if (params.state === "idle") {
    state.queueDepth = Math.max(0, state.queueDepth - 1);
  }
  if (!isProbeSession && diag.isEnabled("debug")) {
    diag.debug(
      `session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${
        state.queueDepth
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logSessionStuck(params: SessionRef & { state: SessionStateValue; ageMs: number }) {
  const state = getDiagnosticSessionState(params);
  diag.warn(
    `stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${state.queueDepth}`,
  );
  emitDiagnosticEvent({
    type: "session.stuck",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logLaneEnqueue(lane: string, queueSize: number) {
  diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number) {
  diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markActivity();
}

export function logRunAttempt(params: SessionRef & { runId: string; attempt: number }) {
  diag.debug(
    `run attempt: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId} attempt=${params.attempt}`,
  );
  emitDiagnosticEvent({
    type: "run.attempt",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    attempt: params.attempt,
  });
  markActivity();
}

export function logToolLoopAction(
  params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
  },
) {
  const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } tool=${params.toolName} level=${params.level} action=${params.action} detector=${
    params.detector
  } count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
  if (params.level === "critical") {
    diag.error(payload);
  } else {
    diag.warn(payload);
  }
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.toolName,
    level: params.level,
    action: params.action,
    detector: params.detector,
    count: params.count,
    message: params.message,
    pairedToolName: params.pairedToolName,
  });
  markActivity();
}

export function logModelResolve(params: {
  sessionId?: string;
  sessionKey?: string;
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
}) {
  diag.debug(
    `model resolve: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId ?? "unknown"} requested=${params.provider}/${params.requestedModel} resolved=${params.resolvedProvider ?? params.provider}/${params.resolvedModel ?? params.requestedModel} resolution=${params.resolution}`,
  );
  emitDiagnosticEvent({
    type: "model.resolve",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    channel: params.channel,
    provider: params.provider,
    requestedModel: params.requestedModel,
    resolvedProvider: params.resolvedProvider,
    resolvedModel: params.resolvedModel,
    resolution: params.resolution,
    baseUrl: params.baseUrl,
  });
  markActivity();
}

export function logModelRequest(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  channel?: string;
  provider: string;
  model: string;
  requestIndex?: number;
  historyMessages?: number;
  imageCount?: number;
}) {
  diag.debug(
    `model request: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId ?? "unknown"} provider=${params.provider} model=${params.model} requestIndex=${params.requestIndex ?? "unknown"} historyMessages=${params.historyMessages ?? 0} imageCount=${params.imageCount ?? 0}`,
  );
  emitDiagnosticEvent({
    type: "model.request",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    channel: params.channel,
    provider: params.provider,
    model: params.model,
    requestIndex: params.requestIndex,
    historyMessages: params.historyMessages,
    imageCount: params.imageCount,
  });
  markActivity();
}

export function logModelResult(params: {
  sessionId?: string;
  sessionKey?: string;
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
}) {
  const payload = `model result: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } runId=${params.runId ?? "unknown"} provider=${params.provider ?? "unknown"} model=${
    params.model ?? "unknown"
  } requestIndex=${params.requestIndex ?? "unknown"} status=${params.status} duration=${
    params.durationMs ?? 0
  }ms input=${params.usage?.input ?? 0} output=${params.usage?.output ?? 0}`;
  if (params.status === "error") {
    diag.warn(`${payload}${params.error ? ` error="${params.error}"` : ""}`);
  } else {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "model.result",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    channel: params.channel,
    provider: params.provider,
    model: params.model,
    requestIndex: params.requestIndex,
    status: params.status,
    durationMs: params.durationMs,
    error: params.error,
    stopReason: params.stopReason,
    usage: params.usage,
  });
  markActivity();
}

export function logToolCall(params: {
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId: string;
  phase: "start" | "result";
  summary?: string;
  status?: "ok" | "error";
  durationMs?: number;
  meta?: string;
}) {
  diag.debug(
    `tool call: sessionKey=${params.sessionKey ?? "unknown"} runId=${params.runId ?? "unknown"} tool=${params.toolName} toolCallId=${params.toolCallId} phase=${params.phase}${params.status ? ` status=${params.status}` : ""}${params.durationMs != null ? ` duration=${params.durationMs}ms` : ""}${params.summary ? ` summary=${params.summary}` : ""}`,
  );
  emitDiagnosticEvent({
    type: "tool.call",
    sessionKey: params.sessionKey,
    runId: params.runId,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    phase: params.phase,
    summary: params.summary,
    status: params.status,
    durationMs: params.durationMs,
    meta: params.meta,
  });
  markActivity();
}

export function logSkillExecution(params: {
  sessionId?: string;
  sessionKey?: string;
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
}) {
  const payload = `skill execution: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } runId=${params.runId ?? "unknown"} source=${params.source} phase=${params.phase}${params.status ? ` status=${params.status}` : ""}${params.skillName ? ` skill=${params.skillName}` : ""}${params.commandName ? ` command=${params.commandName}` : ""}${params.toolName ? ` tool=${params.toolName}` : ""}${params.skillCount != null ? ` skillCount=${params.skillCount}` : ""}${params.durationMs != null ? ` duration=${params.durationMs}ms` : ""}`;
  if (params.status === "error") {
    diag.warn(`${payload}${params.error ? ` error="${params.error}"` : ""}`);
  } else {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "skill.execution",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    channel: params.channel,
    source: params.source,
    phase: params.phase,
    status: params.status,
    skillCount: params.skillCount,
    skillNames: params.skillNames,
    skillName: params.skillName,
    commandName: params.commandName,
    toolName: params.toolName,
    argChars: params.argChars,
    durationMs: params.durationMs,
    error: params.error,
  });
  markActivity();
}

export function logSubagentLifecycle(params: {
  requesterSessionKey?: string;
  requesterSourceSessionKey?: string;
  childSessionKey: string;
  runId: string;
  phase: "spawn_failed" | "registered" | "wait_started" | "wait_result";
  status?: "ok" | "error" | "timeout" | "unknown";
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
}) {
  const payload = `subagent lifecycle: requester=${params.requesterSessionKey ?? "unknown"} child=${params.childSessionKey} runId=${params.runId} phase=${params.phase}${params.status ? ` status=${params.status}` : ""}${params.mode ? ` mode=${params.mode}` : ""}${params.model ? ` model=${params.model}` : ""}${params.routing ? ` routing=${params.routing}` : ""}${params.durationMs != null ? ` duration=${params.durationMs}ms` : ""}`;
  if (params.status === "error") {
    diag.warn(`${payload}${params.error ? ` error="${params.error}"` : ""}`);
  } else {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "subagent.lifecycle",
    requesterSessionKey: params.requesterSessionKey,
    requesterSourceSessionKey: params.requesterSourceSessionKey,
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    phase: params.phase,
    status: params.status,
    cleanup: params.cleanup,
    mode: params.mode,
    label: params.label,
    model: params.model,
    modelApplied: params.modelApplied,
    routing: params.routing,
    taskChars: params.taskChars,
    runTimeoutSeconds: params.runTimeoutSeconds,
    durationMs: params.durationMs,
    error: params.error,
  });
  markActivity();
}

export function logActiveRuns() {
  const activeSessions = Array.from(diagnosticSessionStates.entries())
    .filter(([, s]) => s.state === "processing")
    .map(
      ([id, s]) =>
        `${id}(q=${s.queueDepth},age=${Math.round((Date.now() - s.lastActivity) / 1000)}s)`,
    );
  diag.debug(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
  markActivity();
}

let heartbeatInterval: NodeJS.Timeout | null = null;

export function startDiagnosticHeartbeat(config?: OpenClawConfig) {
  if (heartbeatInterval) {
    return;
  }
  heartbeatInterval = setInterval(() => {
    let heartbeatConfig = config;
    if (!heartbeatConfig) {
      try {
        heartbeatConfig = loadConfig();
      } catch {
        heartbeatConfig = undefined;
      }
    }
    const stuckSessionWarnMs = resolveStuckSessionWarnMs(heartbeatConfig);
    const now = Date.now();
    pruneDiagnosticSessionStates(now, true);
    const activeCount = Array.from(diagnosticSessionStates.values()).filter(
      (s) => s.state === "processing",
    ).length;
    const waitingCount = Array.from(diagnosticSessionStates.values()).filter(
      (s) => s.state === "waiting",
    ).length;
    const totalQueued = Array.from(diagnosticSessionStates.values()).reduce(
      (sum, s) => sum + s.queueDepth,
      0,
    );
    const hasActivity =
      lastActivityAt > 0 ||
      webhookStats.received > 0 ||
      activeCount > 0 ||
      waitingCount > 0 ||
      totalQueued > 0;
    if (!hasActivity) {
      return;
    }
    if (now - lastActivityAt > 120_000 && activeCount === 0 && waitingCount === 0) {
      return;
    }

    diag.debug(
      `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${activeCount} waiting=${waitingCount} queued=${totalQueued}`,
    );
    emitDiagnosticEvent({
      type: "diagnostic.heartbeat",
      webhooks: {
        received: webhookStats.received,
        processed: webhookStats.processed,
        errors: webhookStats.errors,
      },
      active: activeCount,
      waiting: waitingCount,
      queued: totalQueued,
    });

    import("../agents/command-poll-backoff.js")
      .then(({ pruneStaleCommandPolls }) => {
        for (const [, state] of diagnosticSessionStates) {
          pruneStaleCommandPolls(state);
        }
      })
      .catch((err) => {
        diag.debug(`command-poll-backoff prune failed: ${String(err)}`);
      });

    for (const [, state] of diagnosticSessionStates) {
      const ageMs = now - state.lastActivity;
      if (state.state === "processing" && ageMs > stuckSessionWarnMs) {
        logSessionStuck({
          sessionId: state.sessionId,
          sessionKey: state.sessionKey,
          state: state.state,
          ageMs,
        });
      }
    }
  }, 30_000);
  heartbeatInterval.unref?.();
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getDiagnosticSessionStateCountForTest(): number {
  return getDiagnosticSessionStateCountForTestImpl();
}

export function resetDiagnosticStateForTest(): void {
  resetDiagnosticSessionStateForTest();
  webhookStats.received = 0;
  webhookStats.processed = 0;
  webhookStats.errors = 0;
  webhookStats.lastReceived = 0;
  lastActivityAt = 0;
  stopDiagnosticHeartbeat();
}

export { diag as diagnosticLogger };
