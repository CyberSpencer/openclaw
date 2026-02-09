type UnknownRecord = Record<string, unknown>;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function normalizeChannel(value: string): string {
  return value.trim().toLowerCase();
}

export function migrateLegacyCronPayload(payload: UnknownRecord): boolean {
  let mutated = false;

  const channelValue = readString(payload.channel);
  const providerValue = readString(payload.provider);
  const modelValue = readString(payload.model);

  const nextChannel =
    typeof channelValue === "string" && channelValue.trim().length > 0
      ? normalizeChannel(channelValue)
      : typeof providerValue === "string" && providerValue.trim().length > 0
        ? normalizeChannel(providerValue)
        : "";

  if (nextChannel) {
    if (channelValue !== nextChannel) {
      payload.channel = nextChannel;
      mutated = true;
    }
  }

  if ("provider" in payload) {
    delete payload.provider;
    mutated = true;
  }

  // Back-compat: older cron jobs may pin legacy model ids that are no longer shipped/allowed.
  // Prefer migrating to the current stable Codex model id so scheduled jobs keep running.
  if (typeof modelValue === "string") {
    const trimmed = modelValue.trim();
    if (!trimmed) {
      delete payload.model;
      mutated = true;
    } else {
      const migrations: Record<string, string> = {
        "openai-codex/gpt-5.2": "openai-codex/gpt-5.3-codex",
        "openai-codex/gpt-5.3": "openai-codex/gpt-5.3-codex",
      };
      const nextModel = migrations[trimmed] ?? trimmed;
      if (nextModel !== modelValue) {
        payload.model = nextModel;
        mutated = true;
      }
    }
  }

  return mutated;
}
