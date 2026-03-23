import { Type } from "@sinclair/typebox";

export const OrchestratorGetParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const OrchestratorSetParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(Type.String()),
    state: Type.Unknown(),
    baseHash: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
