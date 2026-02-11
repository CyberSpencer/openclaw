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

  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    return;
  }

  const type = record.type;
  if (typeof type !== "string") {
    send({ id, ok: false, error: "Invalid embedding worker message: type is required" });
    return;
  }

  if (type !== "embedQuery" && type !== "embedBatch") {
    send({ id, ok: false, error: `Unsupported embedding worker message type: ${type}` });
    return;
  }

  if (type === "embedQuery") {
    const text = record.text;
    if (typeof text !== "string") {
      send({ id, ok: false, error: "Invalid embedQuery payload: text must be a string" });
      return;
    }

    try {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      send({ id, ok: true, embeddings: [Array.from(embedding.vector)] });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ id, ok: false, error: message });
      return;
    }
  }

  const texts = record.texts;
  if (!Array.isArray(texts) || texts.some((entry) => typeof entry !== "string")) {
    send({ id, ok: false, error: "Invalid embedBatch payload: texts must be a string[]" });
    return;
  }

  try {
    const ctx = await ensureContext();
    const embeddings: number[][] = [];
    for (const text of texts) {
      const embedding = await ctx.getEmbeddingFor(text);
      embeddings.push(Array.from(embedding.vector));
    }
    send({ id, ok: true, embeddings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ id, ok: false, error: message });
  }
}

let queue = Promise.resolve();
process.on("message", (msg) => {
  queue = queue.then(() => handleMessage(msg)).catch(() => undefined);
});
