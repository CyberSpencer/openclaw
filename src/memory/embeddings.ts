import { spawn } from "node:child_process";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";

import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { createGeminiEmbeddingProvider, type GeminiEmbeddingClient } from "./embeddings-gemini.js";
import { createOpenAiEmbeddingProvider, type OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { importNodeLlamaCpp } from "./node-llama.js";

export type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
export type { OpenAiEmbeddingClient } from "./embeddings-openai.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local" | "gemini" | "auto";
  fallbackFrom?: "openai" | "local" | "gemini";
  fallbackReason?: string;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
};

export type EmbeddingProviderOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider: "openai" | "local" | "gemini" | "auto";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: "openai" | "gemini" | "local" | "none";
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const EMBEDDING_WORKER_ENV = "OPENCLAW_EMBEDDINGS_WORKER";
const EMBEDDING_WORKER_IDLE_ENV = "OPENCLAW_EMBEDDINGS_WORKER_IDLE_MS";
const WORKER_QUERY_TIMEOUT_MS = 5 * 60_000;
const WORKER_BATCH_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WORKER_IDLE_MS = 10 * 60_000;

const log = createSubsystemLogger("memory/embeddings");

let llamaSingleton: Promise<Llama> | null = null;
const modelCache = new Map<string, Promise<LlamaModel>>();
const contextCache = new Map<string, Promise<LlamaEmbeddingContext>>();
const contextLocks = new Map<string, Promise<void>>();

type WorkerRequest =
  | { id: string; type: "embedQuery"; text: string }
  | { id: string; type: "embedBatch"; texts: string[] };

type WorkerResponse =
  | { id: string; ok: true; embeddings: number[][] }
  | { id: string; ok: false; error: string };

type EmbeddingWorkerState = {
  client: EmbeddingWorkerClient | null;
  modelKey?: string;
};

const workerState: EmbeddingWorkerState = {
  client: null,
};

function canAutoSelectLocal(options: EmbeddingProviderOptions): boolean {
  const modelPath = options.local?.modelPath?.trim();
  if (!modelPath) {
    return false;
  }
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return false;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isMissingApiKeyError(err: unknown): boolean {
  const message = formatError(err);
  return message.includes("No API key found for provider");
}

function shouldUseEmbeddingWorker(): boolean {
  const envValue = process.env[EMBEDDING_WORKER_ENV]?.trim().toLowerCase();
  if (envValue === "0" || envValue === "false" || envValue === "off") {
    return false;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return false;
  }
  return true;
}

function resolveWorkerIdleMs(): number {
  const raw = process.env[EMBEDDING_WORKER_IDLE_ENV]?.trim();
  if (!raw) {
    return DEFAULT_WORKER_IDLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKER_IDLE_MS;
  }
  return parsed;
}

function resolveWorkerPath(): string | null {
  const direct = fileURLToPath(new URL("./embeddings-worker.js", import.meta.url));
  if (fsSync.existsSync(direct)) {
    return direct;
  }
  const fallback = fileURLToPath(
    new URL("../../dist/memory/embeddings-worker.js", import.meta.url),
  );
  if (fsSync.existsSync(fallback)) {
    return fallback;
  }
  return null;
}

async function withContextLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = contextLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = () => resolve();
  });
  contextLocks.set(
    key,
    prev.then(() => current),
  );
  await prev;
  try {
    return await fn();
  } finally {
    if (releaseCurrent) {
      releaseCurrent();
    }
    if (contextLocks.get(key) === current) {
      contextLocks.delete(key);
    }
  }
}

class EmbeddingWorkerClient {
  private child: ReturnType<typeof spawn> | null;
  private readonly modelPath: string;
  private readonly modelCacheDir?: string;
  private readonly pending = new Map<
    string,
    { resolve: (value: number[][]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;

  constructor(modelPath: string, modelCacheDir?: string) {
    this.modelPath = modelPath;
    this.modelCacheDir = modelCacheDir;
    this.idleMs = resolveWorkerIdleMs();
    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      throw new Error("Embedding worker script not found");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_EMBEDDING_MODEL_PATH: modelPath,
    };
    if (modelCacheDir) {
      env.OPENCLAW_EMBEDDING_MODEL_CACHE_DIR = modelCacheDir;
    }
    this.child = spawn(process.execPath, [workerPath], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    this.child.on("message", (msg) => {
      const response = msg as WorkerResponse;
      const pending = this.pending.get(response?.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.embeddings);
      } else {
        pending.reject(new Error(response.error));
      }
    });

    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `Embedding worker exited (code ${code ?? "unknown"}, signal ${signal ?? "unknown"})`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
    });

    this.child.on("error", (err) => {
      log.warn(`Embedding worker error: ${String(err)}`);
    });

    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          log.warn(`Embedding worker stderr: ${text}`);
        }
      });
    }
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.child) {
      return;
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.child = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private request(type: WorkerRequest["type"], payload: Omit<WorkerRequest, "id" | "type">) {
    if (!this.child) {
      return Promise.reject(new Error("Embedding worker not running"));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const id = `${Date.now()}-${++this.counter}`;
    const timeoutMs = type === "embedBatch" ? WORKER_BATCH_TIMEOUT_MS : WORKER_QUERY_TIMEOUT_MS;
    return this.enqueue(
      () =>
        new Promise<number[][]>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Embedding worker timeout after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
          const wrappedResolve = (value: number[][]) => {
            resolve(value);
            this.scheduleIdle();
          };
          const wrappedReject = (err: Error) => {
            reject(err);
            this.scheduleIdle();
          };
          this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timer });
          const message: WorkerRequest = { id, type, ...(payload as object) } as WorkerRequest;
          this.child?.send(message);
        }),
    );
  }

  private scheduleIdle(): void {
    if (this.pending.size > 0) {
      return;
    }
    if (this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) {
        this.idleTimer = null;
        return;
      }
      this.close();
      if (workerState.client === this) {
        workerState.client = null;
        workerState.modelKey = undefined;
      }
    }, this.idleMs);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.request("embedQuery", { text }).then((vectors) => vectors[0] ?? []);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.request("embedBatch", { texts });
  }

  getModelKey(): string {
    return `${this.modelPath}::${this.modelCacheDir ?? ""}`;
  }
}

function getWorkerClient(modelPath: string, modelCacheDir?: string): EmbeddingWorkerClient {
  const modelKey = `${modelPath}::${modelCacheDir ?? ""}`;
  if (workerState.client && workerState.modelKey === modelKey) {
    return workerState.client;
  }
  if (workerState.client) {
    workerState.client.close();
  }
  const client = new EmbeddingWorkerClient(modelPath, modelCacheDir);
  workerState.client = client;
  workerState.modelKey = modelKey;
  return client;
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  if (shouldUseEmbeddingWorker()) {
    try {
      const client = getWorkerClient(modelPath, modelCacheDir);
      return {
        id: "local",
        model: modelPath,
        embedQuery: (text) => client.embedQuery(text),
        embedBatch: (texts) => client.embedBatch(texts),
      };
    } catch (err) {
      log.warn(`Embedding worker unavailable, falling back to in-process: ${formatError(err)}`);
    }
  }

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let resolvedKey: string | null = null;

  const ensureContext = async () => {
    if (!embeddingModel) {
      const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
      resolvedKey = resolved;
      let modelPromise = modelCache.get(resolved);
      if (!modelPromise) {
        modelPromise = (async () => {
          if (!llamaSingleton) {
            llamaSingleton = getLlama({ logLevel: LlamaLogLevel.error });
          }
          const llama = await llamaSingleton;
          return llama.loadModel({ modelPath: resolved });
        })();
        modelCache.set(resolved, modelPromise);
      }
      try {
        embeddingModel = await modelPromise;
      } catch (err) {
        modelCache.delete(resolved);
        throw err;
      }
    }
    if (!embeddingContext) {
      const contextKey = resolvedKey ?? modelPath;
      let contextPromise = contextCache.get(contextKey);
      if (!contextPromise) {
        contextPromise = embeddingModel.createEmbeddingContext();
        contextCache.set(contextKey, contextPromise);
      }
      try {
        embeddingContext = await contextPromise;
      } catch (err) {
        contextCache.delete(contextKey);
        throw err;
      }
    }
    return embeddingContext;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const lockKey = resolvedKey ?? modelPath;
      return withContextLock(lockKey, async () => {
        const embedding = await ctx.getEmbeddingFor(text);
        return Array.from(embedding.vector);
      });
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const lockKey = resolvedKey ?? modelPath;
      return withContextLock(lockKey, async () => {
        const embeddings: number[][] = [];
        for (const text of texts) {
          const embedding = await ctx.getEmbeddingFor(text);
          embeddings.push(Array.from(embedding.vector));
        }
        return embeddings;
      });
    },
  };
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  const fallback = options.fallback;

  const createProvider = async (id: "openai" | "local" | "gemini") => {
    if (id === "local") {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider };
    }
    if (id === "gemini") {
      const { provider, client } = await createGeminiEmbeddingProvider(options);
      return { provider, gemini: client };
    }
    const { provider, client } = await createOpenAiEmbeddingProvider(options);
    return { provider, openAi: client };
  };

  const formatPrimaryError = (err: unknown, provider: "openai" | "local" | "gemini") =>
    provider === "local" ? formatLocalSetupError(err) : formatError(err);

  if (requestedProvider === "auto") {
    const missingKeyErrors: string[] = [];
    let localError: string | null = null;

    if (canAutoSelectLocal(options)) {
      try {
        const local = await createProvider("local");
        return { ...local, requestedProvider };
      } catch (err) {
        localError = formatLocalSetupError(err);
      }
    }

    for (const provider of ["openai", "gemini"] as const) {
      try {
        const result = await createProvider(provider);
        return { ...result, requestedProvider };
      } catch (err) {
        const message = formatPrimaryError(err, provider);
        if (isMissingApiKeyError(err)) {
          missingKeyErrors.push(message);
          continue;
        }
        throw new Error(message, { cause: err });
      }
    }

    const details = [...missingKeyErrors, localError].filter(Boolean) as string[];
    if (details.length > 0) {
      throw new Error(details.join("\n\n"));
    }
    throw new Error("No embeddings provider available.");
  }

  try {
    const primary = await createProvider(requestedProvider);
    return { ...primary, requestedProvider };
  } catch (primaryErr) {
    const reason = formatPrimaryError(primaryErr, requestedProvider);
    if (fallback && fallback !== "none" && fallback !== requestedProvider) {
      try {
        const fallbackResult = await createProvider(fallback);
        return {
          ...fallbackResult,
          requestedProvider,
          fallbackFrom: requestedProvider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        // oxlint-disable-next-line preserve-caught-error
        throw new Error(
          `${reason}\n\nFallback to ${fallback} failed: ${formatError(fallbackErr)}`,
          { cause: fallbackErr },
        );
      }
    }
    throw new Error(reason, { cause: primaryErr });
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return err.message.includes("node-llama-cpp");
  }
  return false;
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatError(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 22 LTS (recommended for installs/updates)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    'Or set agents.defaults.memorySearch.provider = "openai" (remote).',
  ]
    .filter(Boolean)
    .join("\n");
}
