import createDOMPurify from "dompurify";
import { marked } from "marked";
import { truncateText } from "./format.ts";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const allowedAttrs = ["class", "href", "rel", "target", "title", "start"];
const allowedTagSet = new Set(allowedTags);
const allowedAttrSet = new Set(allowedAttrs);

let hooksInstalled = false;
const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const markdownCache = new Map<string, string>();

type DOMPurifyInstance = ReturnType<typeof createDOMPurify>;

let dompurify: DOMPurifyInstance | null = null;
let dompurifySupport: boolean | null = null;

function getDOMPurify(): DOMPurifyInstance {
  if (dompurify) {
    return dompurify;
  }
  const w = (globalThis as unknown as { window?: unknown }).window ?? globalThis;
  dompurify = createDOMPurify(w as unknown as Window);
  return dompurify;
}

function supportsDOMPurify(instance: DOMPurifyInstance): boolean {
  if (dompurifySupport !== null) {
    return dompurifySupport;
  }
  const explicit = (instance as unknown as { isSupported?: unknown }).isSupported;
  if (explicit === false) {
    dompurifySupport = false;
    return dompurifySupport;
  }
  try {
    const probe = [
      `<script>alert(1)</script>`,
      `<p><a href="javascript:alert(1)">x</a></p>`,
      `<p><a href="https://example.com">ok</a></p>`,
    ].join("");
    const sanitized = String(
      instance.sanitize(probe, {
        ALLOWED_TAGS: allowedTags,
        ALLOWED_ATTR: allowedAttrs,
      }),
    );

    // Some DOM shims cause DOMPurify to over-sanitize and return an empty string.
    // Treat that as unsupported so we fall back to our minimal sanitizer.
    dompurifySupport =
      sanitized.includes("https://example.com") &&
      !sanitized.includes("<script") &&
      !sanitized.includes("javascript:");
  } catch {
    dompurifySupport = false;
  }
  return dompurifySupport;
}

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) {
    return null;
  }
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }
  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}

function installHooks() {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  getDOMPurify().addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) {
      return;
    }
    const href = node.getAttribute("href");
    if (!href) {
      return;
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  });
}

const DANGEROUS_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
]);

function stripControlChars(input: string): string {
  // Remove ASCII control chars (U+0000..U+001F plus DEL), used for URL scheme smuggling.
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    out += input[i];
  }
  return out;
}

function isSafeHref(raw: string): boolean {
  const value = (raw ?? "").trim();
  if (!value) {
    return false;
  }
  // Strip non-printable control characters to prevent protocol smuggling.
  const normalized = stripControlChars(value).trim().toLowerCase();
  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("vbscript:")
  ) {
    return false;
  }
  const match = normalized.match(/^([a-z0-9+.-]+):/);
  if (!match) {
    return true;
  } // relative URL / fragment
  const scheme = match[1];
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

function sanitizeHtmlFallback(html: string): string {
  // Minimal safe sanitizer for non-browser test environments where DOMPurify isn't effective.
  // Prefer using `document.createElement` over `DOMParser`, since some DOM shims implement
  // DOMParser inconsistently.
  const doc =
    (globalThis as unknown as { document?: Document; window?: { document?: Document } }).document ??
    (globalThis as unknown as { window?: { document?: Document } }).window?.document;
  if (!doc) {
    return "";
  }

  // First-pass hardening: strip script tags + javascript: hrefs even if the DOM shim is quirky.
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/href\s*=\s*(["'])\s*(?:javascript|data|vbscript):[^"']*\1/gi, "");

  const root = doc.createElement("div");
  root.innerHTML = cleaned;

  const sanitizeNode = (node: Node) => {
    // Avoid relying on global `Node` in test DOM shims.
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();

      if (!allowedTagSet.has(tag)) {
        if (DANGEROUS_TAGS.has(tag)) {
          const parent = el.parentNode;
          if (parent) {
            parent.removeChild(el);
          }
          return;
        }
        // Unwrap unknown tags to preserve text content.
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          parent.removeChild(el);
        }
        return;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowedAttrSet.has(name) || name.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === "href" && !isSafeHref(attr.value)) {
          el.removeAttribute(attr.name);
        }
        if (name === "start") {
          const num = Number(attr.value);
          if (!Number.isFinite(num)) {
            el.removeAttribute(attr.name);
          }
        }
      }

      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href && isSafeHref(href)) {
          el.setAttribute("rel", "noreferrer noopener");
          el.setAttribute("target", "_blank");
        } else {
          el.removeAttribute("href");
          el.removeAttribute("rel");
          el.removeAttribute("target");
        }
      }
    }

    for (const child of Array.from(node.childNodes)) {
      sanitizeNode(child);
    }
  };

  sanitizeNode(root);
  return root.innerHTML;
}

function sanitizeHtml(html: string): string {
  const DOMPurify = getDOMPurify();
  if (supportsDOMPurify(DOMPurify)) {
    installHooks();
    return String(
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: allowedTags,
        ALLOWED_ATTR: allowedAttrs,
      }),
    );
  }
  return sanitizeHtmlFallback(html);
}

export function toSanitizedMarkdownHtml(markdown: string): string {
  const input = markdown.trim();
  if (!input) {
    return "";
  }
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(input);
    if (cached !== null) {
      return cached;
    }
  }
  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : "";
  if (truncated.text.length > MARKDOWN_PARSE_LIMIT) {
    const escaped = escapeHtml(`${truncated.text}${suffix}`);
    const html = `<pre class="code-block">${escaped}</pre>`;
    const sanitized = sanitizeHtml(html);
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
      setCachedMarkdown(input, sanitized);
    }
    return sanitized;
  }
  const rendered = marked.parse(`${truncated.text}${suffix}`) as string;
  const sanitized = sanitizeHtml(rendered);
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    setCachedMarkdown(input, sanitized);
  }
  return sanitized;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
