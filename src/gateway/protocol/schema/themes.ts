import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const ThemeLabelString = Type.String({ minLength: 1, maxLength: 64 });
const ThemeBriefString = Type.String({ maxLength: 280 });

export const ThemesListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includeArchived: Type.Optional(Type.Boolean()),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ThemesResolveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    id: Type.Optional(NonEmptyString),
    label: Type.Optional(ThemeLabelString),
    sessionKey: Type.Optional(NonEmptyString),
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ThemesCreateParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    label: ThemeLabelString,
    brief: Type.Optional(ThemeBriefString),
  },
  { additionalProperties: false },
);

export const ThemesPatchParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    id: NonEmptyString,
    label: Type.Optional(Type.Union([ThemeLabelString, Type.Null()])),
    brief: Type.Optional(Type.Union([ThemeBriefString, Type.Null()])),
  },
  { additionalProperties: false },
);

export const ThemesArchiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    id: Type.Optional(NonEmptyString),
    label: Type.Optional(ThemeLabelString),
  },
  { additionalProperties: false },
);

export const ThemesSuggestParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
    message: Type.String({ minLength: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);
