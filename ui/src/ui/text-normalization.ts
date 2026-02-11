/**
 * Shared text normalization for UI display and TTS input.
 *
 * Keep this conservative so we do not lose meaning while still stripping
 * markdown noise that sounds bad when spoken.
 */

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function normalizeTextForDisplay(text: string): string {
  if (!text) {
    return "";
  }

  let normalized = normalizeLineEndings(text);
  normalized = normalized.replace(/[ \t]+\n/g, "\n");
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return normalized.trim();
}

export function normalizeTextForTts(text: string): string {
  let normalized = normalizeTextForDisplay(text);
  if (!normalized) {
    return "";
  }

  // Fenced code blocks -> keep inner text, drop fences and language hints.
  normalized = normalized.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, body: string) => {
    const content = String(body ?? "").trim();
    return content ? ` ${content} ` : " ";
  });

  // Inline markdown/link syntax.
  normalized = normalized.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  normalized = normalized.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  normalized = normalized.replace(/`([^`]+)`/g, "$1");

  // Markdown structure markers.
  normalized = normalized.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  normalized = normalized.replace(/^\s*>\s?/gm, "");
  normalized = normalized.replace(/^\s*[-*+]\s+/gm, "");
  normalized = normalized.replace(/^\s*\d+\.\s+/gm, "");

  // Common emphasis wrappers.
  normalized = normalized.replace(/\*\*([^*]+)\*\*/g, "$1");
  normalized = normalized.replace(/\*([^*]+)\*/g, "$1");
  normalized = normalized.replace(/__([^_]+)__/g, "$1");
  normalized = normalized.replace(/_([^_]+)_/g, "$1");
  normalized = normalized.replace(/~~([^~]+)~~/g, "$1");

  // Basic HTML cleanup.
  normalized = normalized.replace(/<[^>]+>/g, " ");

  // Table separators and excessive whitespace/newlines.
  normalized = normalized.replace(/\|/g, " ");
  normalized = normalized.replace(/\s+/g, " ");

  return normalized.trim();
}
