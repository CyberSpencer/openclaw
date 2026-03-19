import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEmbeddedPiAgent } from "../src/agents/pi-embedded-runner/run.js";
import type { OpenClawConfig } from "../src/config/types.js";

type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  bodyText: string;
  bodyJson?: Record<string, unknown>;
};

type FakeCodexServer = {
  baseUrl: string;
  requests: RecordedRequest[];
  healthHits: number;
  runtimeHits: number;
  close: () => Promise<void>;
};

const cleanupTasks: Array<() => Promise<void>> = [];

function buildFakeCodexJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString("base64");
  return `${header}.${payload}.signature`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeCodexSse(res: ServerResponse, text: string): void {
  const messageId = "msg_local_codex";
  const itemId = "item_local_codex";
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_local_codex",
        status: "completed",
        output: [
          {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text,
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 21,
          output_tokens: 7,
          total_tokens: 28,
          input_tokens_details: {
            cached_tokens: 0,
          },
          output_tokens_details: {
            reasoning_tokens: 0,
          },
        },
      },
    },
  ];

  res.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startFakeCodexServer(options: {
  answerText: string;
  healthStatus?: number;
  rejectRuntime?: boolean;
}): Promise<FakeCodexServer> {
  const state = {
    requests: [] as RecordedRequest[],
    healthHits: 0,
    runtimeHits: 0,
  };

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url === "/health") {
      state.healthHits += 1;
      res.writeHead(options.healthStatus ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ ok: (options.healthStatus ?? 200) < 400 }));
      return;
    }

    if (req.method === "POST" && url === "/v1/codex/responses") {
      state.runtimeHits += 1;
      const bodyText = await readBody(req);
      let bodyJson: Record<string, unknown> | undefined;
      try {
        bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        bodyJson = undefined;
      }
      state.requests.push({
        method: req.method ?? "GET",
        url,
        headers: req.headers,
        bodyText,
        bodyJson,
      });

      if (options.rejectRuntime) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "wrong endpoint" } }));
        return;
      }

      writeCodexSse(res, options.answerText);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake Codex server");
  }

  const close = async () => {
    if (!server.listening) {
      return;
    }
    server.close();
    await once(server, "close");
  };

  cleanupTasks.push(close);

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close,
    get requests() {
      return state.requests;
    },
    get healthHits() {
      return state.healthHits;
    },
    get runtimeHits() {
      return state.runtimeHits;
    },
  };
}

function buildConfig(options: {
  baseUrl: string;
  endpoints: Array<{
    id: string;
    baseUrl: string;
    health?: {
      url: string;
    };
    priority?: number;
  }>;
  endpointStrategy: "ordered" | "health";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "openai-codex/gpt-5.3-codex-spark": {
            params: {
              transport: "sse",
            },
          },
        },
      },
    },
    models: {
      providers: {
        "openai-codex": {
          api: "openai-codex-responses",
          apiKey: buildFakeCodexJwt("acct-e2e"),
          baseUrl: options.baseUrl,
          endpointStrategy: options.endpointStrategy,
          endpoints: options.endpoints,
          models: [
            {
              id: "gpt-5.3-codex-spark",
              name: "gpt-5.3-codex-spark",
              provider: "openai-codex",
              api: "openai-codex-responses",
              contextWindow: 400000,
              maxTokens: 32000,
              reasoning: true,
              input: ["text"],
              output: ["text"],
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

async function runSparkPrompt(config: OpenClawConfig, prompt: string) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "openclaw-runtime-proof-agent-"));
  cleanupTasks.push(() => rm(agentDir, { recursive: true, force: true }));

  const sessionFile = path.join(agentDir, "session.jsonl");

  return runEmbeddedPiAgent({
    sessionId: "runtime-proof",
    sessionFile,
    workspaceDir: agentDir,
    agentDir,
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    prompt,
    config,
    timeoutMs: 15_000,
    disableTools: true,
    runId: `run-${Date.now()}`,
    enqueue: async (task) => await task(),
  });
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("embedded runtime proof e2e", () => {
  it("routes Codex Spark runs through the resolved ordered endpoint and streams a real response", async () => {
    const providerBase = await startFakeCodexServer({
      answerText: "provider base should never answer",
      rejectRuntime: true,
    });
    const sparkEndpoint = await startFakeCodexServer({
      answerText: "ordered endpoint says hi",
    });

    const result = await runSparkPrompt(
      buildConfig({
        baseUrl: providerBase.baseUrl,
        endpointStrategy: "ordered",
        endpoints: [
          {
            id: "spark-local",
            baseUrl: sparkEndpoint.baseUrl,
            priority: 0,
          },
        ],
      }),
      "Reply with the ordered endpoint confirmation.",
    );

    expect(result.payloads?.map((payload) => payload.text).join("\n")).toContain(
      "ordered endpoint says hi",
    );
    expect(providerBase.runtimeHits).toBe(0);
    expect(sparkEndpoint.runtimeHits).toBe(1);

    const request = sparkEndpoint.requests[0];
    expect(request?.url).toBe("/v1/codex/responses");
    expect(request?.bodyJson?.model).toBe("gpt-5.3-codex-spark");
    expect(JSON.stringify(request?.bodyJson?.input)).toContain(
      "Reply with the ordered endpoint confirmation.",
    );
    expect(request?.headers["chatgpt-account-id"]).toBe("acct-e2e");
  });

  it("skips unhealthy Codex endpoints before the runtime call and still completes the stream", async () => {
    const providerBase = await startFakeCodexServer({
      answerText: "provider base should never answer",
      rejectRuntime: true,
    });
    const unhealthySpark = await startFakeCodexServer({
      answerText: "unhealthy endpoint should never answer",
      healthStatus: 503,
      rejectRuntime: true,
    });
    const healthySpark = await startFakeCodexServer({
      answerText: "healthy endpoint says hi",
    });

    const result = await runSparkPrompt(
      buildConfig({
        baseUrl: providerBase.baseUrl,
        endpointStrategy: "health",
        endpoints: [
          {
            id: "spark-unhealthy",
            baseUrl: unhealthySpark.baseUrl,
            health: {
              url: unhealthySpark.baseUrl.replace(/\/v1$/, "") + "/health",
            },
            priority: 0,
          },
          {
            id: "spark-healthy",
            baseUrl: healthySpark.baseUrl,
            health: {
              url: healthySpark.baseUrl.replace(/\/v1$/, "") + "/health",
            },
            priority: 1,
          },
        ],
      }),
      "Reply with the healthy endpoint confirmation.",
    );

    expect(result.payloads?.map((payload) => payload.text).join("\n")).toContain(
      "healthy endpoint says hi",
    );
    expect(unhealthySpark.healthHits).toBeGreaterThan(0);
    expect(healthySpark.healthHits).toBeGreaterThan(0);
    expect(providerBase.runtimeHits).toBe(0);
    expect(unhealthySpark.runtimeHits).toBe(0);
    expect(healthySpark.runtimeHits).toBe(1);

    const request = healthySpark.requests[0];
    expect(request?.bodyJson?.model).toBe("gpt-5.3-codex-spark");
    expect(JSON.stringify(request?.bodyJson?.input)).toContain(
      "Reply with the healthy endpoint confirmation.",
    );
  });
});
