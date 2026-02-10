import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

function isBrowserEnabled(): boolean {
  const raw = process.env.VITEST_BROWSER?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export default defineConfig({
  // Vitest runs in Node by default, but our UI code expects browser-flavored exports.
  // Vite includes the "development" export condition in non-production modes, which
  // makes Lit pick dev builds. LinkeDOM is good enough for our unit tests, but Lit's
  // dev-only duplicate attribute binding checks can false-positive there.
  resolve: isBrowserEnabled()
    ? undefined
    : {
        // Prefer Node-flavored exports in unit tests (Lit uses ssr-dom-shim there).
        // Also omit "development" by forcing NODE_ENV=production below.
        conditions: ["node", "import", "module"],
      },
  ssr: isBrowserEnabled()
    ? undefined
    : {
        // Vitest uses Vite's SSR pipeline for module loading, so mirror conditions here too.
        resolve: {
          conditions: ["node", "import", "module"],
        },
      },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: isBrowserEnabled() ? [] : ["src/**/*.browser.test.ts"],
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
