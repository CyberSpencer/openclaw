/**
 * Shared text normalization for UI display and TTS input.
 * Keep this conservative so we preserve meaning while stripping noisy artifacts.
 */

const DUPLICATE_MARKDOWN_LINK_RE = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\))\s*\(https?:\/\/[^)\s]+\)/gi;
const TRAILING_DONE_RE = /\s*\[DONE\]\s*$/i;
const BRACKET_DIRECTIVE_RE = /\[\[[^\]]*\]\]/g;
const SOURCE_CITATION_LINE_RE = /^\s*Source:\s*[^\n]+$/gm;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const PAREN_LONG_ID_RE = /\(\s*[0-9a-fA-F][0-9a-fA-F\s-]{18,}\s*\)/g;
const EMPTY_PARENS_RE = /\(\s*\)/g;

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function normalizeTextForDisplay(text: string): string {
  if (!text) {
    return "";
  }

  let normalized = normalizeLineEndings(text);
  normalized = normalized.replace(BRACKET_DIRECTIVE_RE, "");
  normalized = normalized.replace(SOURCE_CITATION_LINE_RE, "");
  normalized = normalized.replace(DUPLICATE_MARKDOWN_LINK_RE, "$1");
  normalized = normalized.replace(TRAILING_DONE_RE, "");
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

  // Strip long IDs that are bad for speech.
  normalized = normalized.replace(UUID_RE, "");
  normalized = normalized.replace(PAREN_LONG_ID_RE, "");
  normalized = normalized.replace(EMPTY_PARENS_RE, "");

  // Basic HTML cleanup.
  normalized = normalized.replace(/<[^>]+>/g, " ");

  // Table separators and excessive whitespace/newlines.
  normalized = normalized.replace(/\|/g, " ");
  normalized = normalized.replace(/\s+/g, " ");

  return normalized.trim();
}
