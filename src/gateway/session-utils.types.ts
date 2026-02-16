import type { ChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SubagentTaskStatus = "running" | "done" | "error";

export type SubagentTaskRow = {
  taskId: string;
  runId: string;
  assignedRunId: string;
  childSessionKey: string;
  assignedSessionKey: string;
  requesterSessionKey: string;
  label?: string;
  task: string;
  status: SubagentTaskStatus;
  cleanup: "delete" | "keep";
  model?: string;
  modelApplied?: boolean;
  routing?: "explicit" | "simple-kimi" | "configured-default";
  complexity?: "simple" | "complex";
  rootConversationId?: string;
  threadId?: string;
  parentRunId?: string;
  subagentGroupId?: string;
  taskPlanTaskId?: string;
  outcome?: {
    status: "ok" | "error" | "timeout" | "unknown";
    error?: string;
  };
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
};

export type SessionsSubagentsResult = {
  ts: number;
  requesterSessionKey: string;
  count: number;
  active: number;
  tasks: SubagentTaskRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};
