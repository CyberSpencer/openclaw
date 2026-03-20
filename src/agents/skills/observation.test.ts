import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  raw: vi.fn(),
  isEnabled: vi.fn(() => true),
  child: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

const {
  __testing,
  finalizeRunSkillUsageObservation,
  observeSkillCommandInvocation,
  observeSkillDocRead,
  observeSkillsPromptResolved,
  resetSkillUsageObservationsForTesting,
} = await import("./observation.js");

describe("skills observation", () => {
  beforeEach(() => {
    logger.info.mockReset();
    logger.debug.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    logger.fatal.mockReset();
    logger.trace.mockReset();
    logger.raw.mockReset();
    resetSkillUsageObservationsForTesting();
  });

  it("reports no skill used when skills were available but untouched", () => {
    observeSkillsPromptResolved({
      runId: "run-no-skill",
      sessionId: "session-no-skill",
      sessionKey: "chat:session-no-skill",
      workspaceDir: "/tmp/openclaw",
      prompt:
        "<available_skills>\n  <skill><name>weather</name></skill>\n  <skill><name>github</name></skill>\n</available_skills>",
      promptSource: "entries",
    });

    finalizeRunSkillUsageObservation({ runId: "run-no-skill" });

    const summary = logger.info.mock.calls
      .map((call) => call[1])
      .find((meta) => meta?.event === "skill_usage_summary");

    expect(summary).toMatchObject({
      runId: "run-no-skill",
      skillUsed: false,
      noSkillUsed: true,
      selectionSource: "none",
      availableSkillNames: ["weather", "github"],
      selectedSkillNames: [],
    });
    expect(summary?.selectionReason).toContain("no SKILL.md read");
  });

  it("combines explicit skill command and SKILL.md read into one summary", () => {
    observeSkillCommandInvocation({
      sessionKey: "chat:weather",
      skillName: "weather",
      commandName: "weather",
      dispatchKind: "prompt_rewrite",
      hasArgs: true,
    });

    observeSkillsPromptResolved({
      runId: "run-weather",
      sessionId: "session-weather",
      sessionKey: "chat:weather",
      workspaceDir: "/tmp/openclaw",
      prompt:
        "<available_skills>\n  <skill><name>weather</name></skill>\n  <skill><name>github</name></skill>\n</available_skills>",
      promptSource: "entries",
    });

    observeSkillDocRead({
      runId: "run-weather",
      sessionId: "session-weather",
      sessionKey: "chat:weather",
      toolCallId: "tool-1",
      filePath: "/tmp/skills/weather/SKILL.md",
    });

    finalizeRunSkillUsageObservation({ runId: "run-weather" });

    const summary = logger.info.mock.calls
      .map((call) => call[1])
      .find((meta) => meta?.event === "skill_usage_summary" && meta?.runId === "run-weather");

    expect(summary).toMatchObject({
      skillUsed: true,
      noSkillUsed: false,
      selectionSource: "mixed",
      selectedSkillNames: ["weather"],
      invokedSkillNames: ["weather"],
      readSkillNames: ["weather"],
    });
    expect(summary?.commandInvocations).toEqual([
      expect.objectContaining({
        skillName: "weather",
        commandName: "weather",
        dispatchKind: "prompt_rewrite",
        hasArgs: true,
      }),
    ]);
    expect(summary?.skillDocReads).toEqual([
      expect.objectContaining({
        skillName: "weather",
        filePath: "/tmp/skills/weather/SKILL.md",
        toolCallId: "tool-1",
      }),
    ]);
    expect(summary?.selectionReason).toContain("Explicit skill command observed");
  });

  it("recognizes SKILL.md paths and parses prompt skill names", () => {
    expect(
      __testing.resolveSkillDocRead("C:\\Users\\spencer\\clawd\\skills\\weather\\SKILL.md"),
    ).toEqual({
      skillName: "weather",
      filePath: "C:\\Users\\spencer\\clawd\\skills\\weather\\SKILL.md",
    });
    expect(
      __testing.parseSkillNamesFromPrompt(
        "<available_skills><skill><name>weather</name></skill><skill><name>Weather</name></skill></available_skills>",
      ),
    ).toEqual(["weather"]);
  });
});
