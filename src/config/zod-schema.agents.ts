import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema, validateSandboxNetworkMode } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const inheritedAllowContainerNamespaceJoin =
      value.defaults?.sandbox?.docker?.dangerouslyAllowContainerNamespaceJoin === true;

    for (const [index, agent] of (value.list ?? []).entries()) {
      const allowContainerNamespaceJoin =
        agent.sandbox?.docker?.dangerouslyAllowContainerNamespaceJoin ??
        inheritedAllowContainerNamespaceJoin;

      const dockerNetworkIssue = validateSandboxNetworkMode(
        agent.sandbox?.docker?.network,

        allowContainerNamespaceJoin,
      );
      if (dockerNetworkIssue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["list", index, "sandbox", "docker", "network"],
          message: dockerNetworkIssue,
        });
      }

      const browserNetworkIssue = validateSandboxNetworkMode(
        agent.sandbox?.browser?.network,

        allowContainerNamespaceJoin,
      );
      if (browserNetworkIssue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["list", index, "sandbox", "browser", "network"],
          message: browserNetworkIssue,
        });
      }
    }
  })
  .optional();

export const BindingsSchema = z
  .array(
    z
      .object({
        agentId: z.string(),
        comment: z.string().optional(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
            peer: z
              .object({
                kind: z.union([
                  z.literal("direct"),
                  z.literal("group"),
                  z.literal("channel"),
                  /** @deprecated Use `direct` instead. Kept for backward compatibility. */
                  z.literal("dm"),
                ]),
                id: z.string(),
              })
              .strict()
              .optional(),
            guildId: z.string().optional(),
            teamId: z.string().optional(),
            roles: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
