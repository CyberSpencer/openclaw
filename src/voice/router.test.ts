import { describe, expect, it } from "vitest";
import { detectSensitiveData, resolveRouterConfig, routeVoiceRequest } from "./router.js";

describe("voice router", () => {
  it("uses expected defaults and normalizes local model names", () => {
    const defaults = resolveRouterConfig();
    expect(defaults.localModel).toBe("ollama/gpt-oss:120b");
    expect(defaults.cloudModel).toBe("openai-codex/gpt-5.3-codex");

    const normalized = resolveRouterConfig({ localModel: "gpt-oss:120b" });
    expect(normalized.localModel).toBe("ollama/gpt-oss:120b");
  });

  it("detects sensitive payloads", () => {
    const sensitive = detectSensitiveData("api key: sk-live-test-value");
    expect(sensitive.detected).toBe(true);
  });

  it("routes sensitive text to local with no thinking", () => {
    const config = resolveRouterConfig();
    const decision = routeVoiceRequest("api key: sk-live-test-value", config);
    expect(decision.route).toBe("local");
    expect(decision.model).toBe("ollama/gpt-oss:120b");
    expect(decision.thinking).toBe("none");
    expect(decision.sensitiveDetected).toBe(true);
  });

  it("routes complex text to cloud with xhigh thinking", () => {
    const config = resolveRouterConfig({
      complexityThreshold: 0,
      detectSensitive: false,
    });
    const decision = routeVoiceRequest(
      "Analyze the distributed systems trade-off, compare architectures, and explain step by step.",
      config,
    );
    expect(decision.route).toBe("cloud");
    expect(decision.model).toBe("openai-codex/gpt-5.3-codex");
    expect(decision.thinking).toBe("xhigh");
  });

  it("honors fixed local mode", () => {
    const config = resolveRouterConfig({ mode: "local" });
    const decision = routeVoiceRequest("Any question", config);
    expect(decision.route).toBe("local");
    expect(decision.model).toBe("ollama/gpt-oss:120b");
    expect(decision.thinking).toBe("none");
  });
});
