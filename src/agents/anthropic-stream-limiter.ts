/**
 * Semaphore that caps concurrent Anthropic streaming API calls to prevent OOM.
 *
 * Anthropic streams hold large server-side buffers (~35KB+ per context window).
 * Running more than ~3 concurrently on a single process can OOM-crash the gateway.
 * Additional requests are queued (not rejected) until a slot is available.
 *
 * Configurable via: agents.defaults.anthropic.maxConcurrentStreams (default: 3)
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/anthropic-limiter");

const DEFAULT_MAX_CONCURRENT = 3;
const ACQUIRE_TIMEOUT_MS = 60_000;

class StreamSemaphore {
  private current = 0;
  private readonly queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private max: number) {}

  updateMax(newMax: number): void {
    if (newMax === this.max) {
      return;
    }
    this.max = newMax;
    // If max increased, wake waiting requests
    this.drain();
  }

  async acquire(timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        resolve: () => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve();
        },
        reject,
      };
      timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(
          new Error(
            `anthropic-stream-limiter: timed out after ${timeoutMs}ms waiting for a stream slot (${this.current}/${this.max} active, ${this.queue.length} queued)`,
          ),
        );
      }, timeoutMs);
      this.queue.push(entry);
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    this.drain();
  }

  private drain(): void {
    while (this.current < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.current++;
        next.resolve();
      }
    }
  }

  get active(): number {
    return this.current;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

// Module-level singleton — shared across all concurrent embedded runs in the same process.
let _semaphore: StreamSemaphore | null = null;

function getSemaphore(maxConcurrent: number): StreamSemaphore {
  if (!_semaphore) {
    _semaphore = new StreamSemaphore(maxConcurrent);
  } else {
    _semaphore.updateMax(maxConcurrent);
  }
  return _semaphore;
}

/** Reset the singleton (test use only). */
export function resetAnthropicStreamSemaphore(): void {
  _semaphore = null;
}

function resolveMaxConcurrent(config?: OpenClawConfig): number {
  const configured = config?.agents?.defaults?.anthropic?.maxConcurrentStreams;
  if (typeof configured === "number" && configured > 0) {
    return configured;
  }
  return DEFAULT_MAX_CONCURRENT;
}

/**
 * Wraps a StreamFn with a semaphore that limits concurrent Anthropic API streams.
 * Only call this when params.model.api === "anthropic-messages".
 */
export function wrapStreamFnWithAnthropicSemaphore(
  baseFn: StreamFn,
  config?: OpenClawConfig,
): StreamFn {
  return async (model, context, options) => {
    const maxConcurrent = resolveMaxConcurrent(config);
    const semaphore = getSemaphore(maxConcurrent);

    if (semaphore.waiting > 0 || semaphore.active >= maxConcurrent) {
      log.debug(
        `anthropic stream queued: active=${semaphore.active} waiting=${semaphore.waiting} max=${maxConcurrent}`,
      );
    }

    await semaphore.acquire(ACQUIRE_TIMEOUT_MS);

    log.debug(`anthropic stream slot acquired: active=${semaphore.active} max=${maxConcurrent}`);

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        semaphore.release();
        log.debug(
          `anthropic stream slot released: active=${semaphore.active} waiting=${semaphore.waiting} max=${maxConcurrent}`,
        );
      }
    };

    let stream: Awaited<ReturnType<typeof baseFn>>;
    try {
      stream = await Promise.resolve(baseFn(model, context, options));
    } catch (err) {
      release();
      throw err;
    }

    // Wrap result() to release the semaphore when the stream fully resolves.
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      try {
        return await originalResult();
      } finally {
        release();
      }
    };

    // Also wrap the async iterator so early abandonment (error / abort) releases the slot.
    const originalIterator = stream[Symbol.asyncIterator].bind(stream);
    (stream as { [Symbol.asyncIterator]: typeof originalIterator })[Symbol.asyncIterator] =
      function () {
        const iter = originalIterator();
        return {
          async next() {
            const result = await iter.next();
            if (result.done) {
              release();
            }
            return result;
          },
          async return(value?: unknown) {
            release();
            return iter.return?.(value) ?? { done: true as const, value: undefined };
          },
          async throw(error?: unknown) {
            release();
            return iter.throw?.(error) ?? { done: true as const, value: undefined };
          },
        };
      };

    return stream;
  };
}
