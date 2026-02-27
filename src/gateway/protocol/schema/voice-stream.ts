import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const SparkVoiceTtsStreamParamsSchema = Type.Object(
  {
    text: NonEmptyString,
    streamId: Type.Optional(NonEmptyString),
    requestId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    clientMessageId: Type.Optional(NonEmptyString),
    source: Type.Optional(Type.Literal("voice")),
    voice: Type.Optional(Type.String()),
    speaker: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    instruct: Type.Optional(Type.String()),
    style_prompt: Type.Optional(Type.String()),
    format: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SparkVoiceTtsStreamAckSchema = Type.Object(
  {
    streamId: NonEmptyString,
    accepted: Type.Boolean(),
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SparkVoiceTtsCancelParamsSchema = Type.Object(
  {
    streamId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SparkVoiceTtsCancelResultSchema = Type.Object(
  {
    cancelled: Type.Boolean(),
    cancelledStreamIds: Type.Array(NonEmptyString),
    remoteCancelAttempted: Type.Boolean(),
    remoteCancelOk: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const SparkVoiceStreamStartedEventSchema = Type.Object(
  {
    streamId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    format: Type.Optional(Type.String()),
    ts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SparkVoiceStreamChunkEventSchema = Type.Object(
  {
    streamId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    seq: Type.Integer({ minimum: 1 }),
    audioBase64: NonEmptyString,
    isLast: Type.Optional(Type.Boolean()),
    chunkDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    format: Type.Optional(Type.String()),
    sampleRate: Type.Optional(Type.Integer({ minimum: 1 })),
    ts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SparkVoiceStreamCompletedEventSchema = Type.Object(
  {
    streamId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    totalChunks: Type.Integer({ minimum: 0 }),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    ts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SparkVoiceStreamErrorEventSchema = Type.Object(
  {
    streamId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    conversationId: Type.Optional(NonEmptyString),
    turnId: Type.Optional(NonEmptyString),
    code: Type.Optional(NonEmptyString),
    message: NonEmptyString,
    ts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
