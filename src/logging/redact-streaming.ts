import {
  getDefaultRedactPatterns,
  redactSensitiveText,
  type RedactSensitiveMode,
} from "./redact.js";

export type StreamingSensitiveRedactorOptions = {
  mode?: RedactSensitiveMode;
  /** Regex source patterns, same format as logging.redactPatterns / getDefaultRedactPatterns(). */
  patterns?: string[];
  /** Max trailing characters to scan when deciding whether to hold a suffix. Default: 2048. */
  lookbackChars?: number;
};

export type StreamingSensitiveRedactor = {
  process: (chunk: string) => string;
  finalize: () => string;
  reset: () => void;
};

const DEFAULT_LOOKBACK_CHARS = 2048;

// Heuristics to hold trailing suffixes that look like incomplete secrets.
// We anchor to end-of-string so we only hold suffixes.
const HOLD_SUFFIX_RULES: RegExp[] = [
  // Authorization / Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._\-+=]{0,}$/i,

  // Common token prefixes.
  /\bsk-[A-Za-z0-9_-]{0,}$/,
  /\bghp_[A-Za-z0-9]{0,}$/i,
  /\bgithub_pat_[A-Za-z0-9_]{0,}$/i,
  /\bxox[baprs]-[A-Za-z0-9-]{0,}$/i,
  /\bxapp-[A-Za-z0-9-]{0,}$/i,
  /\bgsk_[A-Za-z0-9_-]{0,}$/i,
  /\bAIza[0-9A-Za-z\-_]{0,}$/,
  /\bpplx-[A-Za-z0-9_-]{0,}$/i,
  /\bnpm_[A-Za-z0-9]{0,}$/i,

  // ENV-style assignments (key=value) where value may be incomplete.
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)[^\s"'\\]{0,}$/i,

  // JSON fields where value is still open.
  /"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"[^"]*$/i,

  // CLI flags where value may be incomplete.
  /--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)[^\s"']*$/i,
];

function normalizeMode(mode?: RedactSensitiveMode): RedactSensitiveMode {
  return mode === "off" ? "off" : "tools";
}

function resolvePatterns(patterns?: string[]): string[] {
  return patterns?.length ? patterns : getDefaultRedactPatterns();
}

function computeHoldLen(raw: string, lookbackChars: number): number {
  if (!raw) {
    return 0;
  }
  const lookback = Math.max(64, Math.floor(lookbackChars));
  const tail = raw.slice(-lookback);
  let max = 0;
  for (const rule of HOLD_SUFFIX_RULES) {
    const match = tail.match(rule);
    if (!match?.[0]) {
      continue;
    }
    max = Math.max(max, match[0].length);
  }
  return Math.min(max, tail.length);
}

export function createStreamingSensitiveRedactor(
  options?: StreamingSensitiveRedactorOptions,
): StreamingSensitiveRedactor {
  const mode = normalizeMode(options?.mode);
  const patterns = resolvePatterns(options?.patterns);
  const lookbackChars = options?.lookbackChars ?? DEFAULT_LOOKBACK_CHARS;

  let pending = "";

  const reset = () => {
    pending = "";
  };

  const process = (chunk: string): string => {
    if (!chunk) {
      return "";
    }
    if (mode === "off") {
      return chunk;
    }

    pending += chunk;

    const holdLen = computeHoldLen(pending, lookbackChars);
    const cutIndex = Math.max(0, pending.length - holdLen);
    const emitRaw = pending.slice(0, cutIndex);
    pending = pending.slice(cutIndex);

    if (!emitRaw) {
      return "";
    }

    return redactSensitiveText(emitRaw, { mode, patterns });
  };

  const finalize = (): string => {
    if (mode === "off") {
      const out = pending;
      pending = "";
      return out;
    }

    if (!pending) {
      return "";
    }

    const holdLen = computeHoldLen(pending, lookbackChars);
    let raw = pending;
    pending = "";

    // If the buffer ends with a suspicious suffix, mask it aggressively.
    if (holdLen > 0) {
      raw = `${raw.slice(0, Math.max(0, raw.length - holdLen))}***`;
    }

    return redactSensitiveText(raw, { mode, patterns });
  };

  return { process, finalize, reset };
}
