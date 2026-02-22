import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;
let mockConfig: Record<string, unknown> = {
  skills: {
    entries: {},
    trustGate: { level: "warn" },
  },
};

const mockEvaluateSkillTrustGate = vi.fn(() => ({
  score: 80,
  decision: "allow",
  effectiveDecision: "allow",
  policyLevel: "warn",
  overridden: false,
  overrideRequired: false,
  findings: [],
  summary: "ok",
}));

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => mockConfig,
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  };
});

vi.mock("../../agents/skills.js", () => {
  return {
    evaluateSkillTrustGate: (params: unknown) => mockEvaluateSkillTrustGate(params),
    writeSkillTrustGateAudit: vi.fn(),
    loadWorkspaceSkillEntries: () => [
      {
        skill: {
          name: "brave-search",
          description: "Brave skill",
          source: "openclaw-workspace",
          filePath: "/tmp/brave/SKILL.md",
          baseDir: "/tmp/brave",
        },
        frontmatter: {},
        metadata: {},
        invocation: { userInvocable: true, disableModelInvocation: false },
      },
    ],
  };
});

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;
    mockConfig = {
      skills: {
        entries: {},
        trustGate: { level: "warn" },
      },
    };
    mockEvaluateSkillTrustGate.mockReturnValue({
      score: 80,
      decision: "allow",
      effectiveDecision: "allow",
      policyLevel: "warn",
      overridden: false,
      overrideRequired: false,
      findings: [],
      summary: "ok",
    });

    const { skillsHandlers } = await import("./skills.js");

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });

  it("blocks updates when trust gate returns effective block", async () => {
    writtenConfig = null;
    mockConfig = {
      skills: {
        entries: {},
        trustGate: { level: "block" },
      },
    };
    mockEvaluateSkillTrustGate.mockReturnValue({
      score: 20,
      decision: "block",
      effectiveDecision: "block",
      policyLevel: "block",
      overridden: false,
      overrideRequired: true,
      findings: [],
      summary: "blocked",
    });

    const { skillsHandlers } = await import("./skills.js");

    let ok: boolean | null = null;
    let error: { code?: string; message?: string } | undefined;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        enabled: true,
      },
      respond: (success, _result, err) => {
        ok = success;
        error = err as { code?: string; message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.message).toContain("Trust gate blocked");
    expect(writtenConfig).toBeNull();
  });

  it("rejects trust override approvals without reason", async () => {
    writtenConfig = null;
    mockConfig = {
      skills: {
        entries: {},
        trustGate: { level: "block" },
      },
    };

    const { skillsHandlers } = await import("./skills.js");

    let ok: boolean | null = null;
    let error: { message?: string } | undefined;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        trustOverride: {
          approve: true,
        },
      },
      respond: (success, _result, err) => {
        ok = success;
        error = err as { message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.message).toContain("trustOverride.reason is required");
    expect(writtenConfig).toBeNull();
  });

  it("accepts operator override path for blocked integrations", async () => {
    writtenConfig = null;
    mockConfig = {
      skills: {
        entries: {},
        trustGate: { level: "block" },
      },
    };
    mockEvaluateSkillTrustGate.mockImplementation((params: unknown) => {
      const override =
        params && typeof params === "object" && "override" in (params as Record<string, unknown>)
          ? (params as { override?: { reason?: string } }).override
          : undefined;
      if (override?.reason) {
        return {
          score: 20,
          decision: "block",
          effectiveDecision: "warn",
          policyLevel: "block",
          overridden: true,
          overrideRequired: false,
          findings: [],
          summary: "override",
        };
      }
      return {
        score: 20,
        decision: "block",
        effectiveDecision: "block",
        policyLevel: "block",
        overridden: false,
        overrideRequired: true,
        findings: [],
        summary: "blocked",
      };
    });

    const { skillsHandlers } = await import("./skills.js");

    let ok: boolean | null = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        enabled: true,
        trustOverride: {
          approve: true,
          reason: "Reviewed and approved",
          approvedBy: "ops",
        },
      },
      respond: (success) => {
        ok = success;
      },
    });

    expect(ok).toBe(true);
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            enabled: true,
            trustGateOverride: {
              reason: "Reviewed and approved",
              approvedBy: "ops",
            },
          },
        },
      },
    });
  });
});
