import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("runCronIsolatedAgentTurn webchat announce delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("routes text-only announce delivery back through the requester webchat session", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          channel: "webchat",
          lastChannel: "webchat",
          deliveryContext: { channel: "webchat" },
        },
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          sessionKey: "agent:main:main",
          delivery: { mode: "announce" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterSessionKey: "agent:main:main",
          expectsCompletionMessage: true,
        }),
      );
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(deps.sendMessageSlack).not.toHaveBeenCalled();
      expect(deps.sendMessageDiscord).not.toHaveBeenCalled();
      expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
      expect(deps.sendMessageSignal).not.toHaveBeenCalled();
      expect(deps.sendMessageIMessage).not.toHaveBeenCalled();
    });
  });

  it("keeps delivery bound to a non-main webchat requester session", async () => {
    await withTempCronHome(async (home) => {
      const requesterSessionKey = "agent:main:webchat:dm:user-123";
      const storePath = await writeSessionStoreEntries(home, {
        [requesterSessionKey]: {
          sessionId: "webchat-user-123",
          updatedAt: Date.now(),
          channel: "webchat",
          lastChannel: "webchat",
          deliveryContext: { channel: "webchat", to: "session:webchat-user-123" },
        },
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          channel: "webchat",
          lastChannel: "webchat",
          deliveryContext: { channel: "webchat", to: "session:webchat-main" },
        },
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          sessionKey: requesterSessionKey,
          delivery: { mode: "announce", channel: "webchat", to: "user-123" },
        },
        message: "do it",
        sessionKey: "cron:job-2",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(res.deliveryAttempted).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterSessionKey,
          requesterOrigin: expect.objectContaining({ channel: "webchat" }),
          expectsCompletionMessage: true,
        }),
      );
    });
  });
});
