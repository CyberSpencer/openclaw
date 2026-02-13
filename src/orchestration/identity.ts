import crypto from "node:crypto";

export type OrchestrationIdentityEnvelope = {
  rootConversationId?: string;
  threadId?: string;
  sessionKey?: string;
  runId?: string;
  parentRunId?: string;
  subagentGroupId?: string;
  taskId?: string;
  requesterSessionKey?: string;
  spawnedBySessionKey?: string;
};

function normalizeIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeIdentityEnvelope(
  envelope: Partial<OrchestrationIdentityEnvelope> | undefined,
): OrchestrationIdentityEnvelope | undefined {
  if (!envelope) {
    return undefined;
  }
  const next: OrchestrationIdentityEnvelope = {
    rootConversationId: normalizeIdentityValue(envelope.rootConversationId),
    threadId: normalizeIdentityValue(envelope.threadId),
    sessionKey: normalizeIdentityValue(envelope.sessionKey),
    runId: normalizeIdentityValue(envelope.runId),
    parentRunId: normalizeIdentityValue(envelope.parentRunId),
    subagentGroupId: normalizeIdentityValue(envelope.subagentGroupId),
    taskId: normalizeIdentityValue(envelope.taskId),
    requesterSessionKey: normalizeIdentityValue(envelope.requesterSessionKey),
    spawnedBySessionKey: normalizeIdentityValue(envelope.spawnedBySessionKey),
  };
  return Object.values(next).some(Boolean) ? next : undefined;
}

export function deriveDefaultRootConversationId(sessionKey: string): string {
  const key = sessionKey.trim();
  if (!key) {
    return `conv_${crypto.randomUUID()}`;
  }
  const digest = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  return `conv_${digest}`;
}
