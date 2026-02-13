import { playwright } from "@vitest/browser-playwright";
import { createRequire } from "node:module";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

function isBrowserEnabled(): boolean {
  const raw = process.env.VITEST_BROWSER?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// Vite injects a special "development|production" condition into its default
// `resolve.conditions`. That placeholder becomes "development" unless Vite
// considers the current run "production" (NODE_ENV=production).
//
// Lit publishes dev-only builds behind the "development" condition, and when
// combined with LinkeDOM those dev-only duplicate-attribute checks can throw
// false positives in unit tests. Force production resolution for Node tests.
if (!isBrowserEnabled()) {
  process.env.NODE_ENV = "production";
}

const require = createRequire(import.meta.url);

function coerceLitProdEntry(resolved: string): string {
  // Vite/Vitest will often resolve Lit dependencies using the "development"
  // export condition in tests. When combined with LinkeDOM, Lit's dev-only
  // duplicate-attribute checks can false-positive. Force the non-dev entry.
  return resolved
    .replace(`${path.sep}node${path.sep}development${path.sep}`, `${path.sep}node${path.sep}`)
    .replace(`${path.sep}development${path.sep}`, path.sep);
}

function resolveLitProdEntry(specifier: string): string {
  return coerceLitProdEntry(require.resolve(specifier));
}

const LIT_ALIASES = [
  { find: "lit-html", replacement: resolveLitProdEntry("lit-html") },
  {
    find: "@lit/reactive-element",
    replacement: resolveLitProdEntry("@lit/reactive-element"),
  },
  {
    find: "lit-element/lit-element.js",
    replacement: resolveLitProdEntry("lit-element/lit-element.js"),
  },
];

export default defineConfig({
  // Vitest runs in Node by default, but our UI code expects browser-flavored exports.
  // Vite includes the "development" export condition in non-production modes, which
  // makes Lit pick dev builds. LinkeDOM is good enough for our unit tests, but Lit's
  // dev-only duplicate attribute binding checks can false-positive there.
  resolve: isBrowserEnabled()
    ? undefined
    : {
        alias: LIT_ALIASES,
        // Prefer Node-flavored exports in unit tests (Lit uses ssr-dom-shim there).
        // Also omit "development" by forcing NODE_ENV=production below.
        conditions: ["node", "import", "module"],
      },
  ssr: isBrowserEnabled()
    ? undefined
    : {
        // Vitest uses Vite's SSR pipeline for module loading, so mirror conditions here too.
        resolve: {
          alias: LIT_ALIASES,
          conditions: ["node", "import", "module"],
        },
      },
  optimizeDeps: isBrowserEnabled()
    ? undefined
    : {
        // Avoid prebundling Lit deps in test mode, otherwise Vite can lock in
        // the "development" export condition before our resolve overrides apply.
        exclude: ["lit", "lit-html", "@lit/reactive-element", "lit-element"],
      },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: isBrowserEnabled() ? [] : ["src/**/*.browser.test.ts"],
    environment: isBrowserEnabled() ? "node" : "jsdom",
    setupFiles: isBrowserEnabled() ? [] : ["src/test/setup.ts"],
    // Ensure Vite doesn't include the "development" export condition when resolving packages
    // like `lit-html` and `@lit/reactive-element`, which can cause LinkeDOM false-positives.
    env: isBrowserEnabled() ? {} : { NODE_ENV: "production" },
    browser: isBrowserEnabled()
      ? {
          enabled: true,
          provider: playwright(),
          instances: [{ browser: "chromium", name: "chromium" }],
          headless: true,
          ui: false,
        }
      : undefined,
  },
});
