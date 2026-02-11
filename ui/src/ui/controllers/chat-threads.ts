import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";

export const CHAT_THREADS_DEFAULT_LIMIT = 80;

export type ChatThreadsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatThreadsLoading: boolean;
  chatThreadsResult: SessionsListResult | null;
  chatThreadsError: string | null;
};

export async function loadChatThreads(
  state: ChatThreadsState,
  overrides?: {
    search?: string;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.chatThreadsLoading) {
    return;
  }
  state.chatThreadsLoading = true;
  state.chatThreadsError = null;
  try {
    const params: Record<string, unknown> = {
      includeGlobal: overrides?.includeGlobal ?? false,
      includeUnknown: overrides?.includeUnknown ?? false,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    const limit = overrides?.limit ?? CHAT_THREADS_DEFAULT_LIMIT;
    if (limit > 0) {
      params.limit = limit;
    }
    const search = typeof overrides?.search === "string" ? overrides.search.trim() : "";
    if (search) {
      params.search = search;
    }
    const res = await state.client.request("sessions.list", params);
    if (res) {
      state.chatThreadsResult = res;
    }
  } catch (err) {
    state.chatThreadsError = String(err);
  } finally {
    state.chatThreadsLoading = false;
  }
}
