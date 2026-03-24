const MAX_SUMMARY_CHARS = 160;
const MAX_GENERIC_FIELDS = 6;
const SENSITIVE_KEY_RE =
  /(token|secret|password|authorization|cookie|session|api[_-]?key|bearer|private[_-]?key|otp)/i;
const TEXT_LENGTH_ONLY_KEY_RE =
  /(prompt|content|message|text|body|command|input|output|error|result|task)/i;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateObservabilityText(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  const compacted = compactWhitespace(value);
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function describeScalar(key: string, value: string | number | boolean): string {
  if (typeof value === "string") {
    if (!value.trim()) {
      return `${key}=<empty>`;
    }
    if (SENSITIVE_KEY_RE.test(key)) {
      return `${key}=<redacted:${value.length} chars>`;
    }
    if (TEXT_LENGTH_ONLY_KEY_RE.test(key)) {
      return `${key}Chars=${value.length}`;
    }
    return `${key}=${truncateObservabilityText(value, 64)}`;
  }
  return `${key}=${String(value)}`;
}

function describeObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value).toSorted();
  if (keys.length === 0) {
    return "object{}";
  }
  const parts: string[] = [];
  for (const key of keys.slice(0, MAX_GENERIC_FIELDS)) {
    const entry = value[key];
    if (entry == null) {
      parts.push(`${key}=null`);
      continue;
    }
    if (Array.isArray(entry)) {
      parts.push(`${key}[${entry.length}]`);
      continue;
    }
    if (typeof entry === "object") {
      parts.push(
        `${key}{${Object.keys(entry as Record<string, unknown>)
          .slice(0, 3)
          .join(",")}}`,
      );
      continue;
    }
    parts.push(describeScalar(key, entry as string | number | boolean));
  }
  if (keys.length > MAX_GENERIC_FIELDS) {
    parts.push(`+${keys.length - MAX_GENERIC_FIELDS} keys`);
  }
  return truncateObservabilityText(parts.join(" "));
}

function resolvePathArg(args: Record<string, unknown>): string | undefined {
  const pathValue = typeof args.path === "string" ? args.path : args.file_path;
  return typeof pathValue === "string" && pathValue.trim()
    ? truncateObservabilityText(pathValue, 96)
    : undefined;
}

export function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  if (args == null) {
    return undefined;
  }
  if (typeof args === "string") {
    return `argsChars=${args.length}`;
  }
  if (typeof args !== "object") {
    return `argsType=${typeof args}`;
  }
  const record = args as Record<string, unknown>;
  const path = resolvePathArg(record);
  switch (toolName.trim().toLowerCase()) {
    case "read": {
      const parts = [path ? `path=${path}` : undefined];
      if (typeof record.offset === "number") {
        parts.push(`offset=${record.offset}`);
      }
      if (typeof record.limit === "number") {
        parts.push(`limit=${record.limit}`);
      }
      return parts.filter(Boolean).join(" ") || "read";
    }
    case "write":
      return [
        path ? `path=${path}` : undefined,
        typeof record.content === "string" ? `contentChars=${record.content.length}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "edit":
      return [
        path ? `path=${path}` : undefined,
        typeof record.oldText === "string" ? `oldChars=${record.oldText.length}` : undefined,
        typeof record.newText === "string" ? `newChars=${record.newText.length}` : undefined,
        typeof record.old_string === "string" ? `oldChars=${record.old_string.length}` : undefined,
        typeof record.new_string === "string" ? `newChars=${record.new_string.length}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "exec":
    case "bash": {
      const parts = [
        typeof record.command === "string" ? `commandChars=${record.command.length}` : undefined,
        typeof record.workdir === "string"
          ? `workdir=${truncateObservabilityText(record.workdir, 64)}`
          : undefined,
        record.pty === true ? "pty=true" : undefined,
        record.elevated === true ? "elevated=true" : undefined,
        typeof record.timeout === "number" ? `timeout=${record.timeout}s` : undefined,
      ];
      return parts.filter(Boolean).join(" ") || "exec";
    }
    case "process":
      return [
        typeof record.action === "string" ? `action=${record.action}` : undefined,
        typeof record.sessionId === "string" ? `sessionId=${record.sessionId}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "subagents":
      return [
        typeof record.action === "string" ? `action=${record.action}` : undefined,
        typeof record.target === "string"
          ? `target=${truncateObservabilityText(record.target, 48)}`
          : undefined,
        typeof record.message === "string" ? `messageChars=${record.message.length}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "image": {
      const images = Array.isArray(record.images)
        ? record.images.length
        : record.image
          ? 1
          : undefined;
      return [
        images ? `images=${images}` : undefined,
        typeof record.prompt === "string" ? `promptChars=${record.prompt.length}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    }
    default:
      return describeObject(record);
  }
}

export function summarizeToolResult(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }
  if (typeof result === "string") {
    return `textChars=${result.length}`;
  }
  if (typeof result !== "object") {
    return `resultType=${typeof result}`;
  }
  const record = result as Record<string, unknown>;
  const parts: string[] = [];
  const status =
    typeof record.status === "string"
      ? record.status
      : record.details &&
          typeof record.details === "object" &&
          typeof (record.details as Record<string, unknown>).status === "string"
        ? String((record.details as Record<string, unknown>).status)
        : undefined;
  if (status) {
    parts.push(`status=${status}`);
  }
  if (typeof record.ok === "boolean") {
    parts.push(`ok=${record.ok}`);
  }
  if (Array.isArray(record.content)) {
    parts.push(`content[${record.content.length}]`);
  }
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.message === "string"
        ? record.message
        : undefined;
  if (text) {
    parts.push(`textChars=${text.length}`);
  }
  const keys = Object.keys(record);
  if (keys.length > 0) {
    parts.push(`keys=${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}`);
  }
  return truncateObservabilityText(parts.join(" ")) || describeObject(record);
}
