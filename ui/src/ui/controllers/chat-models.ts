import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

export type ChatModelsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
};

export async function loadChatModels(state: ChatModelsState) {
  if (!state.client || !state.connected || state.chatModelsLoading) {
    return;
  }
  state.chatModelsLoading = true;
  try {
    const res = await state.client.request<{ models?: ModelCatalogEntry[] }>("models.list", {});
    state.chatModelCatalog = Array.isArray(res?.models) ? res.models : [];
  } finally {
    state.chatModelsLoading = false;
  }
}
