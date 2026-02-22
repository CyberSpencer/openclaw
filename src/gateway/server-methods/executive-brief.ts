import type { GatewayRequestHandlers } from "./types.js";
import { buildExecutiveBriefPayload } from "../executive-brief.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecutiveBriefGetParams,
} from "../protocol/index.js";

export const executiveBriefHandlers: GatewayRequestHandlers = {
  "brief.get": async ({ params, respond, context }) => {
    if (!validateExecutiveBriefGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid brief.get params: ${formatValidationErrors(validateExecutiveBriefGetParams.errors)}`,
        ),
      );
      return;
    }

    const payload = await buildExecutiveBriefPayload({
      context,
      preset: typeof params.preset === "string" ? params.preset : undefined,
      windows:
        params.windows && typeof params.windows === "object"
          ? (params.windows as {
              sessionsMinutes?: number;
              usageMinutes?: number;
              orchestratorMinutes?: number;
              cronMinutes?: number;
              messagingMinutes?: number;
            })
          : undefined,
      topActionsLimit:
        typeof params.topActionsLimit === "number" ? params.topActionsLimit : undefined,
    });

    respond(true, payload, undefined);
  },
};
