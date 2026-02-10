import fs from "node:fs";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { migrateLegacyCronPayload } from "../payload-migration.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { recomputeNextRuns } from "./jobs.js";
import { inferLegacyName, normalizeOptionalText } from "./normalize.js";

function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  if (typeof payload.deliver === "boolean") {
    return true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    return true;
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return true;
  }
  return false;
}

function buildDeliveryFromLegacyPayload(payload: Record<string, unknown>) {
  const deliver = payload.deliver;
  const mode = deliver === false ? "none" : "announce";
  const channelRaw =
    typeof payload.channel === "string" ? payload.channel.trim().toLowerCase() : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = { mode };
  if (channelRaw) {
    next.channel = channelRaw;
  }
  if (toRaw) {
    next.to = toRaw;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
  }
  return next;
}

function buildDeliveryPatchFromLegacyPayload(payload: Record<string, unknown>) {
  const deliver = payload.deliver;
  const channelRaw =
    typeof payload.channel === "string" ? payload.channel.trim().toLowerCase() : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = {};
  let hasPatch = false;

  if (deliver === false) {
    next.mode = "none";
    hasPatch = true;
  } else if (deliver === true || toRaw) {
    next.mode = "announce";
    hasPatch = true;
  }
  if (channelRaw) {
    next.channel = channelRaw;
    hasPatch = true;
  }
  if (toRaw) {
    next.to = toRaw;
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? next : null;
}

function mergeLegacyDeliveryInto(
  delivery: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const patch = buildDeliveryPatchFromLegacyPayload(payload);
  if (!patch) {
    return { delivery, mutated: false };
  }

  const next = { ...delivery };
  let mutated = false;

  if ("mode" in patch && patch.mode !== next.mode) {
    next.mode = patch.mode;
    mutated = true;
  }
  if ("channel" in patch && patch.channel !== next.channel) {
    next.channel = patch.channel;
    mutated = true;
  }
  if ("to" in patch && patch.to !== next.to) {
    next.to = patch.to;
    mutated = true;
  }
  if ("bestEffort" in patch && patch.bestEffort !== next.bestEffort) {
    next.bestEffort = patch.bestEffort;
    mutated = true;
  }

  return { delivery: next, mutated };
}

function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}

function normalizePayloadKind(payload: Record<string, unknown>) {
  const raw = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
  if (raw === "agentturn") {
    payload.kind = "agentTurn";
    return true;
  }
  if (raw === "systemevent") {
    payload.kind = "systemEvent";
    return true;
  }
  return false;
}

function inferPayloadIfMissing(raw: Record<string, unknown>) {
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  return false;
}

function copyTopLevelAgentTurnFields(
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = payload[field];
    if (typeof existing === "string" && existing.trim()) {
      return;
    }
    const value = raw[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(1, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof raw.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
    mutated = true;
  }

  if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
    payload.deliver = raw.deliver;
    mutated = true;
  }
  if (
    typeof payload.channel !== "string" &&
    typeof raw.channel === "string" &&
    raw.channel.trim()
  ) {
    payload.channel = raw.channel.trim();
    mutated = true;
  }
  if (typeof payload.to !== "string" && typeof raw.to === "string" && raw.to.trim()) {
    payload.to = raw.to.trim();
    mutated = true;
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof raw.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = raw.bestEffortDeliver;
    mutated = true;
  }
  if (
    typeof payload.provider !== "string" &&
    typeof raw.provider === "string" &&
    raw.provider.trim()
  ) {
    payload.provider = raw.provider.trim();
    mutated = true;
  }

  return mutated;
}

function stripLegacyTopLevelFields(raw: Record<string, unknown>) {
  if ("model" in raw) {
    delete raw.model;
  }
  if ("thinking" in raw) {
    delete raw.thinking;
  }
  if ("timeoutSeconds" in raw) {
    delete raw.timeoutSeconds;
  }
  if ("allowUnsafeExternalContent" in raw) {
    delete raw.allowUnsafeExternalContent;
  }
  if ("message" in raw) {
    delete raw.message;
  }
  if ("text" in raw) {
    delete raw.text;
  }
  if ("deliver" in raw) {
    delete raw.deliver;
  }
  if ("channel" in raw) {
    delete raw.channel;
  }
  if ("to" in raw) {
    delete raw.to;
  }
  if ("bestEffortDeliver" in raw) {
    delete raw.bestEffortDeliver;
  }
  if ("provider" in raw) {
    delete raw.provider;
  }
}

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  // Force reload always re-reads the file to avoid missing cross-service
  // edits on filesystems with coarse mtime resolution.

  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  for (const raw of jobs) {
    const state = raw.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      raw.state = {};
      mutated = true;
    }

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

    if (typeof raw.enabled !== "boolean") {
      raw.enabled = true;
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
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }

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
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
