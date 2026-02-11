/**
 * Shared text normalization helpers inspired by AII Chatbot's FormattedText preprocessing.
 *
 * Goals:
 * - Remove common streaming artifacts ([DONE], duplicate link tails)
 * - Strip internal markers and source citations (for display and TTS)
 * - Improve readability (spacing fixes)
 * - Keep transformations conservative to avoid mangling legitimate content
 */

const DUPLICATE_MARKDOWN_LINK_RE = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\))\s*\(https?:\/\/[^)\s]+\)/gi;
const TRAILING_DONE_RE = /\s*\[DONE\]\s*$/i;
const URL_RE = /https?:\/\/[^\s)]+/g;

/** Internal directive markers (e.g. [[reply_to_current]]) — strip for display and TTS. */
const BRACKET_DIRECTIVE_RE = /\[\[[^\]]*\]\]/g;
/** Standalone "Source: path" or "Source: path#L n-L m" lines — strip for display and TTS. */
const SOURCE_CITATION_LINE_RE = /^\s*Source:\s*[^\n]+$/gm;

/** Standard UUID (8-4-4-4-12 hex) — strip for TTS only. */
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
/** Parenthesized long hex/dash/space blob (e.g. mangled UUID) — strip for TTS only. */
const PAREN_LONG_ID_RE = /\(\s*[0-9a-fA-F][0-9a-fA-F\s-]{18,}\s*\)/g;
/** Empty parentheses left after stripping IDs. */
const EMPTY_PARENS_RE = /\(\s*\)/g;

function protectUrls(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const protectedText = text.replace(URL_RE, (match) => {
    const idx = urls.push(match) - 1;
    return `__URL_PLACEHOLDER_${idx}__`;
  });
  return { text: protectedText, urls };
}

function restoreUrls(text: string, urls: string[]): string {
  return text.replace(/__URL_PLACEHOLDER_(\d+)__/g, (_m, idxRaw) => {
    const idx = Number(idxRaw);
    return Number.isFinite(idx) && idx >= 0 && idx < urls.length ? urls[idx] : "";
  });
}

/**
 * Conservative cleanup for display/rendering.
 */
export function normalizeTextForDisplay(input: string): string {
  if (!input) {
    return "";
  }

  let text = input;

  // Strip internal directive markers (e.g. [[reply_to_current]]).
  text = text.replace(BRACKET_DIRECTIVE_RE, "");

  // Remove source citation lines (e.g. "Source: MEMORY.md#L 3-L 15").
  text = text.replace(SOURCE_CITATION_LINE_RE, "");

  // Remove duplicated URL tails after markdown links.
  text = text.replace(DUPLICATE_MARKDOWN_LINK_RE, "$1");

  // Remove stray stream terminator markers.
  text = text.replace(TRAILING_DONE_RE, "");

  // Fix missing spaces after trademark/copyright symbols.
  text = text.replace(/([™®©])(\S)/g, "$1 $2");

  // Protect URLs before letter/number spacing normalization.
  const protectedUrls = protectUrls(text);
  text = protectedUrls.text;

  // Common LLM artifact: letters and numbers fused.
  text = text.replace(/([A-Za-z])(\d)/g, "$1 $2");
  text = text.replace(/(\d)([A-Za-z])/g, "$1 $2");

  text = restoreUrls(text, protectedUrls.urls);

  // Normalize line endings + collapse excessive blank lines.
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Normalize text for speech synthesis.
 */
export function normalizeTextForTts(input: string): string {
  let text = normalizeTextForDisplay(input);
  if (!text) {
    return "";
  }

  // Remove fenced code markers but keep their content.
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, "");
  text = text.replace(/```/g, "");

  // Inline code and markdown links.
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Headings / list markers / emphasis.
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[-*+]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");

  // Strip long identifiers so TTS doesn't read them aloud.
  text = text.replace(UUID_RE, "");
  text = text.replace(PAREN_LONG_ID_RE, "");
  text = text.replace(EMPTY_PARENS_RE, "");

  // Collapse whitespace for cleaner TTS pacing.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n+/g, " ");
  text = text.replace(/\s{2,}/g, " ");

  return text.trim();
}
