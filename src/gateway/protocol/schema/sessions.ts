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
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    kind: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("subagent")])),
    includeSubagents: Type.Optional(Type.Boolean()),
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
    rootConversationId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    subagentGroupId: Type.Optional(Type.String()),
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
    strictIdentity: Type.Optional(Type.Boolean()),
    rootConversationId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

export const SessionsCreateParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    model: Type.Optional(NonEmptyString),
    parentSessionKey: Type.Optional(NonEmptyString),
    task: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsSendParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SessionsMessagesSubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsMessagesUnsubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SessionsAbortParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    runId: Type.Optional(NonEmptyString),
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
    spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
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
  {
    key: NonEmptyString,
    reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")])),
  },
  { additionalProperties: false },
);

export const SessionsDeleteParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    deleteTranscript: Type.Optional(Type.Boolean()),
    // Internal control: when false, still unbind thread bindings but skip hook emission.
    emitLifecycleHooks: Type.Optional(Type.Boolean()),
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
    /** Specific session key to analyze; if omitted returns all sessions. */
    key: Type.Optional(NonEmptyString),
    /** Start date for range filter (YYYY-MM-DD). */
    startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** End date for range filter (YYYY-MM-DD). */
    endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
    mode: Type.Optional(
      Type.Union([Type.Literal("utc"), Type.Literal("gateway"), Type.Literal("specific")]),
    ),
    /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
    utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
    /** Maximum sessions to return (default 50). */
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Include context weight breakdown (systemPromptReport). */
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
    /** Optional lineage hints for Phase-1 orchestration identity. */
    parentRunId: Type.Optional(Type.String()),
    subagentGroupId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
