import { Type } from "@sinclair/typebox";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

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
    failureReason: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("timeout"), Type.Literal("unknown")]),
    ),
    resultSummary: Type.Optional(Type.String({ maxLength: 2000 })),
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

export const SessionsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    /**
     * Read first 8KB of each session transcript to derive title from first user message.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeDerivedTitles: Type.Optional(Type.Boolean()),
    /**
     * Read last 16KB of each session transcript to extract most recent message preview.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeLastMessage: Type.Optional(Type.Boolean()),
    label: Type.Optional(SessionLabelString),
    spawnedBy: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsSubagentsParamsSchema = Type.Object(
  {
    requesterSessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    includeCompleted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsPreviewParamsSchema = Type.Object(
  {
    keys: Type.Array(NonEmptyString, { minItems: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 20 })),
  },
  { additionalProperties: false },
);

export const SessionsResolveParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    agentId: Type.Optional(NonEmptyString),
    spawnedBy: Type.Optional(NonEmptyString),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsPatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
    thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    /** Task plan (to-do list) used by Control UI orchestration progress. */
    taskPlan: Type.Optional(Type.Union([TaskPlanSchema, Type.Null()])),
    responseUsage: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("tokens"),
        Type.Literal("full"),
        // Backward compat with older clients/stores.
        Type.Literal("on"),
        Type.Null(),
      ]),
    ),
    elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    sendPolicy: Type.Optional(
      Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Null()]),
    ),
    groupActivation: Type.Optional(
      Type.Union([Type.Literal("mention"), Type.Literal("always"), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export const SessionsResetParamsSchema = Type.Object(
  { key: NonEmptyString },
  { additionalProperties: false },
);

export const SessionsDeleteParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    deleteTranscript: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsCompactParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const SessionsUsageParamsSchema = Type.Object(
  {
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    key: Type.Optional(Type.String()),
    includeContextWeight: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SessionsSpawnParamsSchema = Type.Object(
  {
    /** Requester session key that should receive the sub-agent announce/handoff. */
    requesterSessionKey: NonEmptyString,
    /** Sub-agent task prompt. */
    task: NonEmptyString,
    /** Optional label for human display (best-effort). */
    label: Type.Optional(Type.String()),
    /** Optional target agent id override. Defaults to requester agent id. */
    agentId: Type.Optional(NonEmptyString),
    /** Optional model override for the child session (best-effort). */
    model: Type.Optional(Type.String()),
    /** Optional thinking override for this run. */
    thinking: Type.Optional(Type.String()),
    /** Max runtime in seconds (0 = config default). */
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    /** Back-compat alias. Prefer runTimeoutSeconds. */
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    cleanup: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("keep")])),
    /** Optional idempotency key for the spawned run (also becomes runId). */
    idempotencyKey: Type.Optional(NonEmptyString),
    /** Optional requester delivery context hints (helps announce routing). */
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    /** Optional group context for tool policy evaluation. */
    groupId: Type.Optional(Type.String()),
    groupChannel: Type.Optional(Type.String()),
    groupSpace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
