// Defaults for agent metadata when upstream does not supply them.
// Keep these aligned with the workspace's configured primary provider/model.
export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.3-codex";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
