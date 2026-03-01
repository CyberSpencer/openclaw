import { randomUUID } from "node:crypto";
import WebSocket from "ws";

type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type GatewayResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string } | string | null;
};
type GatewayEventFrame = { type: "event"; event: string; payload?: unknown };
type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame | { type: string };

type Pending = {
  resolve: (res: GatewayResFrame) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const url = process.env.OPENCLAW_GATEWAY_URL?.replace(/^http/, "ws") ?? "ws://127.0.0.1:32555";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const timeoutMs = 180_000;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function run() {
  const ws = new WebSocket(url, { handshakeTimeout: 20_000 });
  const pending = new Map<string, Pending>();

  const request = async (method: string, params?: unknown) => {
    const id = randomUUID();
    const frame: GatewayReqFrame = { type: "req", id, method, params };
    return new Promise<GatewayResFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });
  };

  const waitOpen = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });

  ws.on("message", (raw) => {
    let frame: GatewayFrame;
    try {
      const payload =
        typeof raw === "string"
          ? raw
          : raw instanceof Uint8Array
            ? new TextDecoder().decode(raw)
            : "";
      frame = JSON.parse(payload) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.type !== "res") {
      return;
    }
    const res = frame as GatewayResFrame;
    const wait = pending.get(res.id);
    if (!wait) {
      return;
    }
    clearTimeout(wait.timeout);
    pending.delete(res.id);
    wait.resolve(res);
  });

  await waitOpen;

  const auth = token ? { token } : undefined;
  const connect = await request("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "test",
      displayName: "voice capability regression",
      version: "dev",
      platform: process.platform,
      mode: "test",
      instanceId: "voice-cap-regression",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: ["tool-events"],
    auth,
  });
  if (!connect.ok) {
    throw new Error(
      `connect failed: ${asText((connect.error as { message?: string } | undefined)?.message)}`,
    );
  }

  try {
    const scenarios: Array<{
      name: string;
      steps: Array<{ text: string; allowTools?: boolean }>;
      verify: (responses: string[], thinking: string[]) => { ok: boolean; reason?: string };
    }> = [
      {
        name: "continuity_facts",
        steps: [
          {
            text: "Remember these constraints: budget is 42k, deadline is March 15, codename is Falcon.",
          },
          { text: "Acknowledge those constraints in one sentence." },
          { text: "Also the primary contact is Dana." },
          { text: "Quick recap: what are the budget, deadline, codename, and contact?" },
        ],
        verify: (responses) => {
          const last = responses[responses.length - 1]?.toLowerCase() ?? "";
          const checks = ["42", "march", "falcon", "dana"];
          const missing = checks.filter((v) => !last.includes(v));
          return missing.length === 0
            ? { ok: true }
            : { ok: false, reason: `missing fields in recap: ${missing.join(",")}` };
        },
      },
      {
        name: "correction_priority",
        steps: [
          { text: "Budget is 42k." },
          { text: "Correction, budget is 38k now." },
          { text: "What is the current budget?" },
        ],
        verify: (responses) => {
          const last = responses[responses.length - 1]?.toLowerCase() ?? "";
          if (last.includes("38")) {
            return { ok: true };
          }
          return { ok: false, reason: "did not preserve corrected value (38k)" };
        },
      },
      {
        name: "execution_lane_thinking",
        steps: [{ text: "Prepare and execute an action plan for this update.", allowTools: true }],
        verify: (_responses, thinking) => {
          const level = (thinking[0] ?? "").toLowerCase();
          if (level === "high" || level === "medium" || level === "xhigh") {
            return { ok: true };
          }
          return {
            ok: false,
            reason: `expected elevated thinking on tool lane, got ${level || "empty"}`,
          };
        },
      },
    ];

    const results: Array<{ name: string; ok: boolean; reason?: string }> = [];

    for (const scenario of scenarios) {
      const sessionKey = `webchat-voice-cap-${scenario.name}`;
      const responses: string[] = [];
      const thinking: string[] = [];
      let scenarioFailedReason: string | undefined;

      for (const step of scenario.steps) {
        try {
          const res = await request("voice.processText", {
            text: step.text,
            sessionKey,
            skipTts: true,
            source: "voice",
            allowTools: step.allowTools ?? false,
            latencyProfile: "short_turn_fast",
            maxOutputTokens: 120,
          });
          if (!res.ok) {
            scenarioFailedReason = `${scenario.name}: voice.processText failed`;
            break;
          }
          const payload = (res.payload ?? {}) as Record<string, unknown>;
          responses.push(asText(payload.response));
          thinking.push(asText(payload.thinkingLevel));
        } catch (err) {
          scenarioFailedReason = `${scenario.name}: ${String(err)}`;
          break;
        }
      }

      if (scenarioFailedReason) {
        results.push({ name: scenario.name, ok: false, reason: scenarioFailedReason });
        continue;
      }

      const verdict = scenario.verify(responses, thinking);
      results.push({ name: scenario.name, ok: verdict.ok, reason: verdict.reason });
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    console.log(
      JSON.stringify(
        {
          url,
          scenarios: results,
          passed,
          total: results.length,
          failed,
        },
        null,
        2,
      ),
    );

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    ws.close();
    setTimeout(() => ws.terminate(), 50).unref();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
