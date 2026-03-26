import type { ModelCatalogEntry } from "./types.ts";

export type ChatModelOverride = string;

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildChatModelRef(provider: string | null | undefined, model: string): string {
  const normalizedModel = normalize(model);
  if (!normalizedModel) {
    return "";
  }
  const normalizedProvider = normalize(provider);
  if (!normalizedProvider || normalizedModel.includes("/")) {
    return normalizedModel;
  }
  return `${normalizedProvider}/${normalizedModel}`;
}

export function resolveServerChatModelValue(
  model: string | null | undefined,
  provider: string | null | undefined,
): string {
  return buildChatModelRef(provider, model ?? "");
}

export function createChatModelOverride(
  value: string | null | undefined,
): ChatModelOverride | null {
  const normalized = normalize(value);
  return normalized || null;
}

export function normalizeChatModelOverrideValue(
  value: ChatModelOverride | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  const normalized = normalize(value ?? "");
  if (!normalized) {
    return "";
  }
  if (normalized.includes("/")) {
    return normalized;
  }
  const matches = catalog.filter((entry) => entry.id === normalized);
  if (matches.length === 1) {
    return buildChatModelRef(matches[0]?.provider, matches[0]?.id ?? normalized);
  }
  return normalized;
}

export function formatChatModelDisplay(modelRef: string | null | undefined): string {
  const normalized = normalize(modelRef ?? "");
  if (!normalized) {
    return "Default model";
  }
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return normalized;
  }
  const provider = normalized.slice(0, slashIndex);
  const model = normalized.slice(slashIndex + 1);
  return `${model} • ${provider}`;
}

export function buildChatModelOption(entry: ModelCatalogEntry): {
  value: string;
  label: string;
} {
  const value = buildChatModelRef(entry.provider, entry.id);
  const displayName = normalize(entry.name) || entry.id;
  const label =
    displayName === entry.id
      ? `${entry.id} • ${entry.provider}`
      : `${displayName} (${entry.provider}/${entry.id})`;
  return { value, label };
}
