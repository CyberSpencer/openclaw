import { Type } from "@sinclair/typebox";

import { callGateway } from "../../gateway/call.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const TaskPlanStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("skipped"),
]);

const TaskPlanTaskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 80 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    detail: Type.Optional(Type.String({ maxLength: 4000 })),
    status: Type.Optional(TaskPlanStatusSchema),
    assignedSessionKey: Type.Optional(Type.String({ maxLength: 240 })),
    assignedRunId: Type.Optional(Type.String({ maxLength: 240 })),
  },
  { additionalProperties: false },
);

const TaskPlanSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 80 }),
    goal: Type.Optional(Type.String({ maxLength: 4000 })),
    tasks: Type.Array(TaskPlanTaskSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

const OrchestrationPlanToolSchema = Type.Object(
  {
    action: Type.Optional(Type.Union([Type.Literal("set"), Type.Literal("clear")])),
    plan: Type.Optional(TaskPlanSchema),
  },
  { additionalProperties: false },
);

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "todo";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "todo" ||
    normalized === "running" ||
    normalized === "done" ||
    normalized === "blocked" ||
    normalized === "skipped"
  ) {
    return normalized;
  }
  return "todo";
}

function normalizePlan(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const goal = typeof record.goal === "string" ? record.goal.trim() : undefined;
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks = rawTasks
    .map((task) => {
      if (!task || typeof task !== "object" || Array.isArray(task)) return null;
      const t = task as Record<string, unknown>;
      const taskId = typeof t.id === "string" ? t.id.trim() : "";
      const title = typeof t.title === "string" ? t.title.trim() : "";
      if (!taskId || !title) return null;
      const detail = typeof t.detail === "string" ? t.detail.trim() : undefined;
      const status = normalizeStatus(t.status);
      const assignedSessionKey =
        typeof t.assignedSessionKey === "string" ? t.assignedSessionKey.trim() : undefined;
      const assignedRunId =
        typeof t.assignedRunId === "string" ? t.assignedRunId.trim() : undefined;
      return {
        id: taskId,
        title,
        ...(detail ? { detail } : {}),
        status,
        ...(assignedSessionKey ? { assignedSessionKey } : {}),
        ...(assignedRunId ? { assignedRunId } : {}),
      };
    })
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
    .slice(0, 50);

  return {
    id,
    ...(goal ? { goal } : {}),
    tasks,
  };
}

export function createOrchestrationPlanTool(opts?: {
  agentSessionKey?: string;
  agentRunId?: string;
}): AnyAgentTool {
  return {
    label: "Orchestration",
    name: "orchestration_plan",
    description:
      "Publish/update a structured task plan (to-do list) for the supervising agent. The Control UI uses this to render progress + map tasks to sub-agents. Call early with a full plan, then update statuses as work completes.",
    parameters: OrchestrationPlanToolSchema,
    execute: async (_toolCallId, args) => {
      const runId = opts?.agentRunId?.trim();
      if (!runId) {
        return jsonResult({
          status: "error",
          error: "orchestration_plan unavailable (missing agentRunId)",
        });
      }

      const params = args as Record<string, unknown>;
      const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "set";

      if (action === "clear") {
        emitAgentEvent({
          runId,
          stream: "orchestration",
          sessionKey: opts?.agentSessionKey,
          data: { type: "task_plan", plan: null },
        });
        if (opts?.agentSessionKey) {
          try {
            await callGateway({
              method: "sessions.patch",
              params: { key: opts.agentSessionKey, taskPlan: null },
              timeoutMs: 10_000,
            });
          } catch (err) {
            return jsonResult({
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return jsonResult({ status: "ok", cleared: true });
      }

      const normalized = normalizePlan(params.plan);
      if (!normalized) {
        return jsonResult({ status: "error", error: "plan required" });
      }

      emitAgentEvent({
        runId,
        stream: "orchestration",
        sessionKey: opts?.agentSessionKey,
        data: { type: "task_plan", plan: normalized },
      });

      let persisted = false;
      let persistError: string | undefined;
      if (opts?.agentSessionKey) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: opts.agentSessionKey, taskPlan: normalized },
            timeoutMs: 10_000,
          });
          persisted = true;
        } catch (err) {
          persistError = err instanceof Error ? err.message : String(err);
        }
      }

      return jsonResult({
        status: "ok",
        persisted,
        ...(persistError ? { persistError } : {}),
      });
    },
  };
}
