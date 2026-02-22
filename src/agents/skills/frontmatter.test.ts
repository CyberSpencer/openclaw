import { describe, expect, it } from "vitest";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";

describe("resolveOpenClawMetadata", () => {
  it("parses trust metadata fields", () => {
    const metadata = resolveOpenClawMetadata({
      metadata:
        '{"openclaw":{"trust":{"permissionScope":["read"],"tokenHandling":{"policy":"ephemeral","redactionRequired":true},"network":{"mode":"allowlist","targets":["api.example.com"]},"provenance":{"source":"clawhub","publisher":"openclaw","signature":"verified"}}}}',
    });

    expect(metadata?.trust?.permissionScope).toEqual(["read"]);
    expect(metadata?.trust?.tokenHandling?.policy).toBe("ephemeral");
    expect(metadata?.trust?.network?.mode).toBe("allowlist");
    expect(metadata?.trust?.network?.targets).toEqual(["api.example.com"]);
    expect(metadata?.trust?.provenance?.source).toBe("clawhub");
    expect(metadata?.trust?.provenance?.signature).toBe("verified");
  });
});

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});
