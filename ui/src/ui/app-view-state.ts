import type { OpenClawApp } from "./app.ts";

// AppViewState is the rendering-time shape of the main Control UI host.
// Keep it as an alias to the Lit element class so view helpers don't drift.
export type AppViewState = OpenClawApp;
