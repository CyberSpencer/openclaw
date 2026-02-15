import {
  getDefaultRedactPatterns,
  redactSensitiveText,
  resolveRedactSensitiveOptionsFromConfig,
  type RedactSensitiveMode,
} from "./redact.js";

export type StreamingSensitiveRedactorOptions = {
  mode?: RedactSensitiveMode;
  /** Regex source patterns, same format as logging.redactPatterns / getDefaultRedactPatterns(). */
  patterns?: string[];
  /**
   * Max trailing characters to scan when deciding whether to hold a suffix.
   * Minimum enforced: 64. Default: 2048.
   */
  lookbackChars?: number;
};

export type StreamingSensitiveRedactor = {
  process: (chunk: string) => string;
  finalize: () => string;
  reset: () => void;
};

const DEFAULT_LOOKBACK_CHARS = 2048;

const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_END_LOOKBACK_CHARS = 256;

// Heuristics to hold trailing suffixes that look like incomplete secrets.
// We anchor to end-of-string so we only hold suffixes.
const HOLD_SUFFIX_RULES: RegExp[] = [
  // Authorization / Bearer tokens.
  // Important: include the bare `Bearer` prefix so we can hold when the stream
  // splits between "Bearer" and the trailing whitespace / token payload.
  /\bBearer(?:\s+[A-Za-z0-9._\-+=]{0,})?$/i,

  // Common token prefixes.
  // Important: include the bare prefix (e.g. `sk`) so we can hold when the stream
  // splits between the prefix and the separator (e.g. "sk" + "-" + ...).
  /\bsk(?:-[A-Za-z0-9_-]{0,})?$/,
  /\bghp(?:_[A-Za-z0-9]{0,})?$/i,
  /\bgithub_pat(?:_[A-Za-z0-9_]{0,})?$/i,
  /\bxox[baprs](?:-[A-Za-z0-9-]{0,})?$/i,
  /\bxapp(?:-[A-Za-z0-9-]{0,})?$/i,
  /\bgsk(?:_[A-Za-z0-9_-]{0,})?$/i,
  /\bAIza(?:[0-9A-Za-z\-_]{0,})?$/,
  /\bpplx(?:-[A-Za-z0-9_-]{0,})?$/i,
  /\bnpm(?:_[A-Za-z0-9]{0,})?$/i,

  // Telegram-style tokens.
  /\b\d{6,}:[A-Za-z0-9_-]{0,}$/,

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

function findUnterminatedPemBeginIndex(raw: string): number | null {
  let lastBeginIndex: number | null = null;
  const beginGlobal = new RegExp(PEM_BEGIN_RE.source, "g");
  for (const match of raw.matchAll(beginGlobal)) {
    if (match.index !== undefined) {
      lastBeginIndex = match.index;
    }
  }
  if (lastBeginIndex === null) {
    return null;
  }
  const afterBegin = raw.slice(lastBeginIndex);
  if (PEM_END_RE.test(afterBegin)) {
    return null;
  }
  return lastBeginIndex;
}

function computeHoldLen(raw: string, lookbackChars: number): number {
  if (!raw) {
    return 0;
  }

  // Sticky hold: if we see the beginning of a private key block but not the end yet,
  // hold everything from the BEGIN marker onward.
  const pemBeginIndex = findUnterminatedPemBeginIndex(raw);
  if (pemBeginIndex !== null) {
    return raw.length - pemBeginIndex;
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
  const resolvedFromConfig =
    options?.mode === undefined && options?.patterns === undefined
      ? resolveRedactSensitiveOptionsFromConfig()
      : null;

  const mode = normalizeMode(options?.mode ?? resolvedFromConfig?.mode);
  const patterns = resolvePatterns(options?.patterns ?? resolvedFromConfig?.patterns);
  const lookbackChars = options?.lookbackChars ?? DEFAULT_LOOKBACK_CHARS;

  let pending = "";
  let pemGuardActive = false;
  let pemEndScan = "";

  const reset = () => {
    pending = "";
    pemGuardActive = false;
    pemEndScan = "";
  };

  const process = (chunk: string): string => {
    if (!chunk) {
      return "";
    }
    if (mode === "off") {
      return chunk;
    }

    if (pemGuardActive) {
      pemEndScan = `${pemEndScan}${chunk}`.slice(-PEM_END_LOOKBACK_CHARS);
      if (PEM_END_RE.test(pemEndScan)) {
        pemGuardActive = false;
        pemEndScan = "";
      }
      return "";
    }

    pending += chunk;

    // Guardrail: if we detect an unterminated private key block that is growing without
    // bound, stop buffering and suppress output until the END marker is observed.
    const pemBeginIndex = findUnterminatedPemBeginIndex(pending);
    if (pemBeginIndex !== null) {
      const pemLen = pending.length - pemBeginIndex;
      const maxPemHoldChars = Math.max(4096, Math.floor(lookbackChars) * 4);
      if (pemLen > maxPemHoldChars) {
        const emitRaw = pending.slice(0, pemBeginIndex);
        pending = "";
        pemGuardActive = true;
        pemEndScan = chunk.slice(-PEM_END_LOOKBACK_CHARS);
        const prefix = emitRaw ? redactSensitiveText(emitRaw, { mode, patterns }) : "";
        return `${prefix}***`;
      }
    }

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

    if (pemGuardActive) {
      pending = "";
      pemGuardActive = false;
      pemEndScan = "";
      return "";
    }

    if (!pending) {
      return "";
    }

    const holdLen = computeHoldLen(pending, lookbackChars);
    const raw = pending;
    pending = "";

    // First attempt: normal regex redaction. If this changes the buffer,
    // it is safe to emit (even if the suffix matches a hold rule).
    const redacted = redactSensitiveText(raw, { mode, patterns });
    if (redacted !== raw) {
      return redacted;
    }

    // Otherwise, the buffer contains a suspicious suffix that does not match
    // redaction patterns yet (likely an incomplete token). Mask it aggressively.
    if (holdLen > 0) {
      const masked = `${raw.slice(0, Math.max(0, raw.length - holdLen))}***`;
      return redactSensitiveText(masked, { mode, patterns });
    }

    return redacted;
  };

  return { process, finalize, reset };
}
