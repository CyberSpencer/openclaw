import { DOMParser, Node, parseHTML } from "linkedom";

// Lit defaults to dev-mode checks unless told otherwise.
// In unit tests we prefer to render even if templates have non-fatal issues.
process.env.NODE_ENV = "production";
(globalThis as unknown as { litDevMode?: boolean }).litDevMode = false;

const globalObj = globalThis as unknown as Record<string, unknown>;
let window = globalObj.window as Window | undefined;

// Prefer a real DOM provided by the Vitest environment (e.g. happy-dom).
// Fall back to LinkeDOM when running in plain Node.
if (
  !window ||
  typeof window !== "object" ||
  !(window as unknown as { document?: unknown }).document
) {
  ({ window } = parseHTML("<html><body></body></html>"));
  globalObj.window = window;
  globalObj.document = window.document;
  globalObj.self = window;
}

// Ensure document/self are wired even if the environment only injected `window`.
if (typeof globalObj.document === "undefined") {
  globalObj.document = window.document;
}
if (typeof globalObj.self === "undefined") {
  globalObj.self = window;
}

const winGlobal = window as unknown as typeof globalThis;

// Ensure the core DOM classes exist before importing anything that touches web components.
if (typeof globalObj.HTMLElement === "undefined") {
  globalObj.HTMLElement = winGlobal.HTMLElement;
}
if (typeof globalObj.Element === "undefined") {
  globalObj.Element = winGlobal.Element;
}
if (typeof globalObj.Node === "undefined") {
  globalObj.Node = winGlobal.Node;
}

// Newer Node versions expose a read-only `navigator` on globalThis.
// Only polyfill it when missing to avoid TypeErrors in the test harness.
if (typeof globalThis.navigator === "undefined") {
  globalObj.navigator = window.navigator;
}
if (typeof globalObj.customElements === "undefined") {
  globalObj.customElements = window.customElements;
}

const sharedGlobals = [
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "Text",
  "Comment",
  "MutationObserver",
  "DOMParser",
];

for (const key of sharedGlobals) {
  // Some Node versions expose stub DOM globals (present but undefined).
  // Prefer the linkedom implementation whenever the global is missing OR undefined.
  if ((globalObj[key] === undefined || !(key in globalObj)) && key in window) {
    globalObj[key] = window[key as keyof typeof window] as unknown;
  }
}

// linkedom does not ship getComputedStyle, but some UI tests rely on it existing.
// They will spy/mock it per-test as needed.
if (typeof globalThis.getComputedStyle !== "function") {
  const defaultGetComputedStyle = () => ({ overflowY: "auto" }) as unknown as CSSStyleDeclaration;
  globalObj.getComputedStyle = defaultGetComputedStyle;
  if (
    typeof (window as unknown as { getComputedStyle?: unknown }).getComputedStyle !== "function"
  ) {
    (window as unknown as { getComputedStyle: unknown }).getComputedStyle = defaultGetComputedStyle;
  }
}

// linkedom does not always expose DOMParser on window, but our markdown sanitizer fallback needs it.
if (typeof globalThis.DOMParser === "undefined") {
  globalObj.DOMParser = DOMParser as unknown;
}

if (typeof globalThis.Node === "undefined") {
  globalObj.Node = Node as unknown;
}

// Keep HTMLElement wired up even if Node provides a stub.
if (typeof globalThis.HTMLElement === "undefined") {
  globalObj.HTMLElement = winGlobal.HTMLElement;
}

if (typeof globalObj.MouseEvent !== "function") {
  globalObj.MouseEvent = class MouseEvent extends (globalObj.Event as typeof Event) {
    readonly button: number;
    readonly clientX: number;
    readonly clientY: number;

    constructor(type: string, options: MouseEventInit = {}) {
      super(type, options);
      this.button = options.button ?? 0;
      this.clientX = options.clientX ?? 0;
      this.clientY = options.clientY ?? 0;
    }
  };
}

if (typeof globalObj.KeyboardEvent !== "function") {
  globalObj.KeyboardEvent = class KeyboardEvent extends (globalObj.Event as typeof Event) {
    readonly key: string;

    constructor(type: string, options: KeyboardEventInit = {}) {
      super(type, options);
      this.key = options.key ?? "";
    }
  };
}

// Vitest expects matchMedia for some code paths.
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

// Lit rendering tests rely on requestAnimationFrame.
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
}

// Provide a tiny localStorage stub used by routing tests.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}
