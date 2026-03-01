export type SparkMicGatewayClient = {
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export function decodeBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("FileReader error"));
    });
    reader.readAsDataURL(blob);
  });
}

export function mergeSparkMicTranscript(existing: string, incoming: string): string {
  const base = existing.trim();
  const next = incoming.trim();
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  const baseWords = base.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const maxOverlap = Math.min(8, baseWords.length, nextWords.length);

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const baseSuffix = baseWords.slice(-overlap).join(" ").toLowerCase();
    const nextPrefix = nextWords.slice(0, overlap).join(" ").toLowerCase();
    if (baseSuffix === nextPrefix) {
      const tail = nextWords.slice(overlap).join(" ").trim();
      return tail ? `${base} ${tail}` : base;
    }
  }

  return `${base} ${next}`;
}

export function loadSparkMicTelemetryFromStorage(): Array<Record<string, unknown>> {
  try {
    const raw = localStorage.getItem("openclaw.sparkMicTelemetry");
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && typeof item === "object").slice(0, 200) as Array<
      Record<string, unknown>
    >;
  } catch {
    return [];
  }
}

export function persistSparkMicTelemetryToStorage(telemetry: Array<Record<string, unknown>>): void {
  try {
    localStorage.setItem("openclaw.sparkMicTelemetry", JSON.stringify(telemetry.slice(0, 120)));
  } catch {
    // ignore storage quota/access issues
  }
}

export async function requestSparkMicStt(params: {
  client: SparkMicGatewayClient | null;
  connected: boolean;
  audioBase64: string;
  format: string;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  if (!params.client || !params.connected) {
    throw new Error("gateway disconnected");
  }

  const requestPromise = params.client.request("spark.voice.stt", {
    audio_base64: params.audioBase64,
    format: params.format,
    sample_rate: params.sampleRate,
  });
  requestPromise.catch(() => undefined);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("STT_TIMEOUT"));
    }, params.timeoutMs);
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
