import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, it, expect, beforeEach } from "vitest";
import {
  resetAnthropicStreamSemaphore,
  wrapStreamFnWithAnthropicSemaphore,
} from "./anthropic-stream-limiter.js";

// Minimal EventStream stub matching the pi-ai type
function makeStream(
  events: unknown[],
  finalResult: unknown,
): {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
} {
  let _done = false;
  const doneResolvers: Array<() => void> = [];

  return {
    result: async () => {
      await new Promise<void>((res) => setTimeout(res, 0));
      return finalResult;
    },
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next() {
          if (idx < events.length) {
            return { value: events[idx++], done: false };
          }
          _done = true;
          doneResolvers.forEach((r) => r());
          return { value: undefined, done: true };
        },
        async return() {
          _done = true;
          doneResolvers.forEach((r) => r());
          return { value: undefined, done: true };
        },
        async throw() {
          _done = true;
          doneResolvers.forEach((r) => r());
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function makeStreamFn(delayMs = 0): { fn: StreamFn; calls: number } {
  let calls = 0;
  const fn: StreamFn = ((_model, _context, _options) => {
    calls++;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(
          makeStream([{ type: "text", text: "hi" }], {
            role: "assistant",
            content: [],
          }),
        );
      }, delayMs);
    });
  }) as unknown as StreamFn;
  return {
    fn,
    get calls() {
      return calls;
    },
  } as { fn: StreamFn; calls: number };
}

beforeEach(() => {
  resetAnthropicStreamSemaphore();
});

describe("wrapStreamFnWithAnthropicSemaphore", () => {
  it("passes through to underlying streamFn", async () => {
    const { fn } = makeStreamFn();
    const wrapped = wrapStreamFnWithAnthropicSemaphore(fn, undefined);
    const stream = await (wrapped as unknown as (...args: unknown[]) => Promise<unknown>)(
      {},
      {},
      {},
    );
    expect(stream).toBeDefined();
  });

  it("limits concurrent calls to default max (3)", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const slowFn: StreamFn = ((_m, _c, _o) => {
      active++;
      if (active > maxActive) {
        maxActive = active;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          const stream = makeStream([], { role: "assistant", content: [] });
          // Wrap to track active release
          const origResult = stream.result.bind(stream);
          stream.result = async () => {
            const r = await origResult();
            active--;
            order.push("released");
            return r;
          };
          resolve(stream);
        }, 20);
      });
    }) as unknown as StreamFn;

    const wrapped = wrapStreamFnWithAnthropicSemaphore(slowFn, undefined);

    // Launch 5 concurrent calls
    const calls = Array.from({ length: 5 }, (_, i) =>
      (wrapped as unknown as (...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>)(
        {},
        {},
        {},
      ).then((s) => {
        order.push(`started-${i}`);
        return s.result();
      }),
    );

    await Promise.all(calls);

    // Should never exceed 3 concurrent
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("respects maxConcurrentStreams from config", async () => {
    let maxActive = 0;
    let active = 0;

    const slowFn: StreamFn = ((_m, _c, _o) => {
      active++;
      if (active > maxActive) {
        maxActive = active;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          const stream = makeStream([], { role: "assistant", content: [] });
          const origResult = stream.result.bind(stream);
          stream.result = async () => {
            const r = await origResult();
            active--;
            return r;
          };
          resolve(stream);
        }, 20);
      });
    }) as unknown as StreamFn;

    const config = {
      agents: { defaults: { anthropic: { maxConcurrentStreams: 1 } } },
    } as Parameters<typeof wrapStreamFnWithAnthropicSemaphore>[1];

    const wrapped = wrapStreamFnWithAnthropicSemaphore(slowFn, config);

    const calls = Array.from({ length: 3 }, () =>
      (wrapped as unknown as (...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>)(
        {},
        {},
        {},
      ).then((s) => s.result()),
    );

    await Promise.all(calls);
    expect(maxActive).toBeLessThanOrEqual(1);
  });

  it("releases the slot when result() throws", async () => {
    const failFn: StreamFn = ((_m, _c, _o) => {
      const stream = makeStream([], null);
      const origResult = stream.result.bind(stream);
      stream.result = async () => {
        await origResult();
        throw new Error("API failure");
      };
      return Promise.resolve(stream);
    }) as unknown as StreamFn;

    const config = {
      agents: { defaults: { anthropic: { maxConcurrentStreams: 1 } } },
    } as Parameters<typeof wrapStreamFnWithAnthropicSemaphore>[1];

    const wrapped = wrapStreamFnWithAnthropicSemaphore(failFn, config);

    await expect(
      (wrapped as unknown as (...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>)(
        {},
        {},
        {},
      ).then((s) => s.result()),
    ).rejects.toThrow("API failure");

    // Slot should be released — next call should succeed immediately
    const successFn: StreamFn = ((_m, _c, _o) =>
      Promise.resolve(makeStream([], { role: "assistant", content: [] }))) as unknown as StreamFn;

    const wrapped2 = wrapStreamFnWithAnthropicSemaphore(successFn, config);
    const stream = await (
      wrapped2 as unknown as (...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>
    )({}, {}, {});
    await stream.result(); // Should not hang
  });
});
