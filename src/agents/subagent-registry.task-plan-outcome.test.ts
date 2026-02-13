import { describe, expect, it } from "vitest";
import { deriveTaskPlanTerminalStateForOutcome } from "./subagent-registry.js";

describe("deriveTaskPlanTerminalStateForOutcome", () => {
  it("maps ok to done without failure metadata", () => {
    expect(deriveTaskPlanTerminalStateForOutcome({ status: "ok" })).toEqual({ status: "done" });
  });

  it("maps error to blocked with reason and summary", () => {
    expect(deriveTaskPlanTerminalStateForOutcome({ status: "error", error: "boom" })).toEqual({
      status: "blocked",
      failureReason: "error",
      resultSummary: "boom",
    });
  });

  it("maps timeout to blocked with timeout reason", () => {
    expect(deriveTaskPlanTerminalStateForOutcome({ status: "timeout" })).toEqual({
      status: "blocked",
      failureReason: "timeout",
      resultSummary: "Subagent run timed out before completion.",
    });
  });

  it("maps unknown to blocked with unknown reason", () => {
    expect(deriveTaskPlanTerminalStateForOutcome({ status: "unknown" })).toEqual({
      status: "blocked",
      failureReason: "unknown",
      resultSummary: "Subagent run ended with unknown outcome.",
    });
  });
});
