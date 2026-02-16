export type ChatAttachment = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
};

export type TaskPlanStatus = "todo" | "running" | "done" | "blocked" | "skipped";

export type TaskPlanTask = {
  id: string;
  title: string;
  detail?: string;
  status?: TaskPlanStatus;
  assignedSessionKey?: string;
  assignedRunId?: string;
  failureReason?: "error" | "timeout" | "unknown";
  resultSummary?: string;
};

export type TaskPlan = {
  id: string;
  goal?: string;
  tasks: TaskPlanTask[];
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  timeoutSeconds: string;
};
