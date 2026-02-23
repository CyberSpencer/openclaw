import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../agents/schema/typebox.js";

export const ExecutiveBriefPresetSchema = stringEnum(["am", "pm"]);

export const ExecutiveBriefWindowsSchema = Type.Object(
  {
    sessionsMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
    usageMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
    orchestratorMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
    cronMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
    messagingMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 10080 })),
  },
  { additionalProperties: false },
);

export const ExecutiveBriefGetParamsSchema = Type.Object(
  {
    preset: Type.Optional(ExecutiveBriefPresetSchema),
    windows: Type.Optional(ExecutiveBriefWindowsSchema),
    topActionsLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  },
  { additionalProperties: false },
);
