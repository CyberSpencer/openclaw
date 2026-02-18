import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("NVIDIA provider", () => {
  it("includes nvidia when NVIDIA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.nvidia).toBeDefined();
      expect(providers?.nvidia?.apiKey).toBe("NVIDIA_API_KEY");
      expect(providers?.nvidia?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
      const ids = providers?.nvidia?.models?.map((model) => model.id);
      expect(ids).toContain("moonshotai/kimi-k2.5");
    } finally {
      if (previous === undefined) {
        delete process.env.NVIDIA_API_KEY;
      } else {
        process.env.NVIDIA_API_KEY = previous;
      }
    }
  });
});
