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
  clearAgent: boolean;
  enabled: boolean;
  deleteAfterRun: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  scheduleExact: boolean;
  staggerAmount: string;
  staggerUnit: "seconds" | "minutes";
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  payloadModel: string;
  payloadThinking: string;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  deliveryBestEffort: boolean;
  failureAlertMode: "inherit" | "disabled" | "custom";
  failureAlertAfter: string;
  failureAlertCooldownSeconds: string;
  failureAlertChannel: string;
  failureAlertTo: string;
  timeoutSeconds: string;
};
