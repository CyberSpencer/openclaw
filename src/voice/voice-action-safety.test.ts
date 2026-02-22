import { describe, expect, it } from "vitest";
import {
  detectVoiceConfirmation,
  requiresVoiceActionConfirmation,
  resolveVoiceActionSafety,
} from "./router.js";

describe("voice action safety confirmation", () => {
  it("requires confirmation for high-risk voice actions", () => {
    expect(requiresVoiceActionConfirmation("message.send")).toBe(true);
    expect(requiresVoiceActionConfirmation("nodes.invoke")).toBe(true);
    expect(requiresVoiceActionConfirmation("exec")).toBe(true);
  });

  it("does not require confirmation for read-only voice actions", () => {
    expect(requiresVoiceActionConfirmation("web_fetch")).toBe(false);
    expect(requiresVoiceActionConfirmation("browser.snapshot")).toBe(false);
  });

  it("detects explicit spoken confirmation", () => {
    expect(detectVoiceConfirmation("yes, send it")).toBe(true);
    expect(detectVoiceConfirmation("go ahead")).toBe(true);
    expect(detectVoiceConfirmation("confirm")).toBe(true);
    expect(detectVoiceConfirmation("maybe later")).toBe(false);
  });

  it("blocks high-risk voice actions without confirmation", () => {
    const decision = resolveVoiceActionSafety({
      action: "message.send",
      transcript: "send this now",
    });
    expect(decision.allow).toBe(false);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.reason).toContain("confirmation required");
  });

  it("allows high-risk voice actions when confirmed", () => {
    const spoken = resolveVoiceActionSafety({
      action: "message.send",
      transcript: "yes, send it",
    });
    expect(spoken.allow).toBe(true);
    expect(spoken.confirmed).toBe(true);

    const explicit = resolveVoiceActionSafety({
      action: "nodes.run",
      transcript: "run it",
      confirmed: true,
    });
    expect(explicit.allow).toBe(true);
    expect(explicit.confirmed).toBe(true);
  });
});
