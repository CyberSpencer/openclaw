import { migrateLegacyCronPayload } from "../payload-migration.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { inferLegacyName, normalizeOptionalText } from "./normalize.js";
import type { CronServiceState } from "./state.js";

const storeCache = new Map<string, { version: 1; jobs: CronJob[] }>();

export async function ensureLoaded(state: CronServiceState) {
  if (state.store) {
    return;
  }
  const cached = storeCache.get(state.deps.storePath);
  if (cached) {
    state.store = cached;
    return;
  }
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  for (const raw of jobs) {
    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalText(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    const payload = raw.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const payloadRecord = payload as Record<string, unknown>;
      const modelBefore =
        typeof payloadRecord.model === "string" ? payloadRecord.model.trim() : undefined;
      if (migrateLegacyCronPayload(payloadRecord)) {
        mutated = true;
      }
      const modelAfter =
        typeof payloadRecord.model === "string" ? payloadRecord.model.trim() : undefined;
      const rawState = raw.state;
      if (rawState && typeof rawState === "object" && !Array.isArray(rawState)) {
        const lastError = (rawState as { lastError?: unknown }).lastError;
        const lastStatus = (rawState as { lastStatus?: unknown }).lastStatus;

        if (
          modelBefore &&
          modelAfter &&
          modelBefore !== modelAfter &&
          lastStatus === "error" &&
          typeof lastError === "string" &&
          lastError.includes(modelBefore)
        ) {
          // If we migrated an invalid/stale model id, clear the stored error so the UI doesn't
          // keep showing an obsolete failure after upgrade.
          delete (rawState as { lastError?: string }).lastError;
          delete (rawState as { lastStatus?: string }).lastStatus;
          mutated = true;
        }

        // If the payload no longer references the model mentioned by a previous allowlist error,
        // clear it to avoid confusing stale errors.
        if (lastStatus === "error" && typeof lastError === "string") {
          const match = lastError.match(/^model not allowed:\s*(.+)\s*$/i);
          const denied = match?.[1]?.trim() ?? "";
          if (
            denied &&
            (denied === "openai-codex/gpt-5.2" || denied === "openai-codex/gpt-5.3") &&
            modelAfter &&
            modelAfter !== denied
          ) {
            delete (rawState as { lastError?: string }).lastError;
            delete (rawState as { lastStatus?: string }).lastStatus;
            mutated = true;
          }
        }
      }
    }
  }
  state.store = { version: 1, jobs: jobs as unknown as CronJob[] };
  storeCache.set(state.deps.storePath, state.store);
  if (mutated) {
    await persist(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store);
}
