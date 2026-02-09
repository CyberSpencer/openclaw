import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

import { importNodeLlamaCpp } from "./node-llama.js";

type WorkerRequest =
  | { id: string; type: "embedQuery"; text: string }
  | { id: string; type: "embedBatch"; texts: string[] };

type WorkerResponse =
  | { id: string; ok: true; embeddings: number[][] }
  | { id: string; ok: false; error: string };

const modelPath = process.env.OPENCLAW_EMBEDDING_MODEL_PATH;
const modelCacheDir = process.env.OPENCLAW_EMBEDDING_MODEL_CACHE_DIR;

if (!modelPath) {
  throw new Error("OPENCLAW_EMBEDDING_MODEL_PATH is required for embeddings worker");
}

let llamaPromise: Promise<Llama> | null = null;
let modelPromise: Promise<LlamaModel> | null = null;
let contextPromise: Promise<LlamaEmbeddingContext> | null = null;

async function ensureContext(): Promise<LlamaEmbeddingContext> {
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();
  const resolvedModelPath = modelPath;
  if (!resolvedModelPath) {
    throw new Error("OPENCLAW_EMBEDDING_MODEL_PATH is required for embeddings worker");
  }
  if (!llamaPromise) {
    llamaPromise = getLlama({ logLevel: LlamaLogLevel.error });
  }
  if (!modelPromise) {
    const resolved = await resolveModelFile(resolvedModelPath, modelCacheDir || undefined);
    modelPromise = (await llamaPromise).loadModel({ modelPath: resolved });
  }
  if (!contextPromise) {
    contextPromise = (await modelPromise).createEmbeddingContext();
  }
  return contextPromise;
}

function send(response: WorkerResponse) {
  if (process.send) {
    process.send(response);
  }
}

async function handleMessage(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const msg = raw as WorkerRequest;
  if (!msg.id || !msg.type) {
    return;
  }
  try {
    const ctx = await ensureContext();
    if (msg.type === "embedQuery") {
      const embedding = await ctx.getEmbeddingFor(msg.text);
      send({ id: msg.id, ok: true, embeddings: [Array.from(embedding.vector)] });
      return;
    }
    if (msg.type === "embedBatch") {
      const embeddings: number[][] = [];
      for (const text of msg.texts) {
        const embedding = await ctx.getEmbeddingFor(text);
        embeddings.push(Array.from(embedding.vector));
      }
      send({ id: msg.id, ok: true, embeddings });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ id: msg.id, ok: false, error: message });
  }
}

let queue = Promise.resolve();
process.on("message", (msg) => {
  queue = queue.then(() => handleMessage(msg)).catch(() => undefined);
});
