import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

import { importNodeLlamaCpp } from "./node-llama.js";

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
  // Validate input at runtime, worker messages originate from an untyped IPC boundary.
  const msg = raw as Record<string, unknown>;
  const id = typeof msg.id === "string" ? msg.id : "";
  const type = typeof msg.type === "string" ? msg.type : "";
  if (!id || !type) {
    return;
  }
  if (type !== "embedQuery" && type !== "embedBatch") {
    send({ id, ok: false, error: `unsupported message type: ${type}` });
    return;
  }
  try {
    const ctx = await ensureContext();
    if (type === "embedQuery") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text) {
        send({ id, ok: false, error: "embedQuery expects text" });
        return;
      }
      const embedding = await ctx.getEmbeddingFor(text);
      send({ id, ok: true, embeddings: [Array.from(embedding.vector)] });
      return;
    }
    if (type === "embedBatch") {
      const texts = Array.isArray(msg.texts) ? msg.texts : null;
      if (!texts || texts.some((text) => typeof text !== "string")) {
        send({ id, ok: false, error: "embedBatch expects texts[]" });
        return;
      }
      const embeddings: number[][] = [];
      for (const text of texts) {
        const embedding = await ctx.getEmbeddingFor(text);
        embeddings.push(Array.from(embedding.vector));
      }
      send({ id, ok: true, embeddings });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ id, ok: false, error: message });
  }
}

let queue = Promise.resolve();
process.on("message", (msg) => {
  queue = queue.then(() => handleMessage(msg)).catch(() => undefined);
});
