import { describe, expect, it } from "vitest";
import type { SkillEntry, SkillTrustMetadata } from "./types.js";
import { evaluateSkillTrustGate } from "./trust-gate.js";

function makeEntry(trust?: SkillTrustMetadata): SkillEntry {
  return {
    skill: {
      name: "demo-skill",
      description: "Demo skill",
      source: "openclaw-workspace",
      filePath: "/tmp/demo-skill/SKILL.md",
      baseDir: "/tmp/demo-skill",
    } as SkillEntry["skill"],
    frontmatter: {},
    metadata: trust ? { trust } : undefined,
    invocation: { userInvocable: true, disableModelInvocation: false },
  };
}

describe("evaluateSkillTrustGate", () => {
  it("returns allow for well-scoped integrations", () => {
    const result = evaluateSkillTrustGate({
      entry: makeEntry({
        permissionScope: ["read"],
        tokenHandling: { policy: "ephemeral", redactionRequired: true },
        network: { mode: "allowlist", targets: ["api.github.com"] },
        provenance: {
          source: "clawhub",
          publisher: "openclaw",
          signature: "verified",
        },
      }),
      policy: { level: "block" },
    });

    expect(result.decision).toBe("allow");
    expect(result.effectiveDecision).toBe("allow");
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("returns warn for medium-risk integrations", () => {
    const result = evaluateSkillTrustGate({
      entry: makeEntry({
        permissionScope: ["write"],
        tokenHandling: { policy: "scoped", redactionRequired: false },
        network: { mode: "restricted" },
        provenance: { source: "workspace", publisher: "local" },
      }),
      policy: { level: "block" },
    });

    expect(result.decision).toBe("warn");
    expect(result.effectiveDecision).toBe("warn");
    expect(result.score).toBeLessThan(70);
    expect(result.score).toBeGreaterThanOrEqual(45);
  });

  it("returns block in strict mode for high-risk integrations", () => {
    const result = evaluateSkillTrustGate({
      entry: makeEntry({
        permissionScope: ["admin"],
        tokenHandling: { policy: "persistent", redactionRequired: false },
        network: { mode: "any" },
      }),
      policy: { level: "block" },
    });

    expect(result.decision).toBe("block");
    expect(result.effectiveDecision).toBe("block");
    expect(result.overrideRequired).toBe(true);
  });

  it("allows operator override for blocked integrations", () => {
    const result = evaluateSkillTrustGate({
      entry: makeEntry({
        permissionScope: ["admin"],
        tokenHandling: { policy: "persistent", redactionRequired: false },
        network: { mode: "any" },
      }),
      policy: { level: "block" },
      override: {
        reason: "Reviewed by security operator",
        approvedAt: new Date().toISOString(),
        approvedBy: "ops@example.com",
      },
    });

    expect(result.decision).toBe("block");
    expect(result.effectiveDecision).toBe("warn");
    expect(result.overridden).toBe(true);
    expect(result.overrideRequired).toBe(false);
  });

  it("penalizes unrecognized token handling policy values", () => {
    const result = evaluateSkillTrustGate({
      entry: makeEntry({
        permissionScope: ["write"],
        tokenHandling: {
          policy: "mystery-policy" as unknown as SkillTrustMetadata["tokenHandling"]["policy"],
          redactionRequired: true,
        },
        network: { mode: "allowlist", targets: ["api.github.com"] },
      }),
      policy: { level: "block" },
    });

    expect(
      result.findings.some((finding) => finding.message.includes("unknown token policy")),
    ).toBe(true);
    expect(result.score).toBeLessThan(70);
  });
});
