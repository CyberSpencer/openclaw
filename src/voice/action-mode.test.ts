import { describe, expect, it } from "vitest";
import {
  classifyVoiceActionIntent,
  formatAllowedVoiceActionIntents,
  isVoiceActionIntentAllowed,
  resolveVoiceActionPolicy,
} from "./action-mode.js";

describe("voice action mode intent classification", () => {
  it("recognizes the constrained intent set", () => {
    expect(classifyVoiceActionIntent("status check on spark")).toBe("status");
    expect(classifyVoiceActionIntent("triage my inbox quickly")).toBe("triage");
    expect(classifyVoiceActionIntent("draft a reply to Sam")).toBe("draft");
    expect(classifyVoiceActionIntent("schedule a meeting tomorrow")).toBe("schedule");
  });

  it("separates external-send and unknown intents", () => {
    expect(classifyVoiceActionIntent("send this to the team")).toBe("external_send");
    expect(classifyVoiceActionIntent("tell me a joke")).toBe("unknown");
  });
});

describe("voice action mode policy", () => {
  it("honors allowlist overrides", () => {
    const policy = resolveVoiceActionPolicy({
      OPENCLAW_VOICE_ACTION_ALLOWED_INTENTS: "status,draft",
    } as NodeJS.ProcessEnv);

    expect(formatAllowedVoiceActionIntents(policy)).toEqual(["status", "draft"]);
    expect(isVoiceActionIntentAllowed("status", policy)).toBe(true);
    expect(isVoiceActionIntentAllowed("draft", policy)).toBe(true);
    expect(isVoiceActionIntentAllowed("triage", policy)).toBe(false);
  });
});
