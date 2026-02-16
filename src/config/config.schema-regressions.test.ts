import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts custom multi-endpoint providers + qdrant store + top-level voice compat", () => {
    const res = validateConfigObject({
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            endpointStrategy: "health",
            endpoints: [
              {
                id: "local",
                baseUrl: "http://127.0.0.1:11434",
                priority: 100,
                health: { path: "/api/tags" },
              },
            ],
            models: [{ id: "llama3", name: "Llama 3" }],
          },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            store: {
              driver: "qdrant",
              qdrant: {
                url: "http://127.0.0.1:6333",
                collection: "memory",
              },
            },
          },
        },
      },
      voice: {
        enabled: true,
        mode: "custom",
      },
    });

    expect(res.ok).toBe(true);
  });
});
