/**
 * Browser-safe usage chip strings for Control UI (no Node-only deps).
 * Keep reset/percent semantics aligned with provider-usage.format.ts.
 */
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

const IGNORED_ERRORS = new Set([
  "No credentials",
  "No token",
  "No API key",
  "Not logged in",
  "No auth",
]);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function formatResetRemaining(targetMs: number | undefined, now: number): string | null {
  if (!targetMs) {
    return null;
  }
  const diffMs = targetMs - now;
  if (diffMs <= 0) {
    return "now";
  }
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ${hours % 24}h`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(targetMs));
}

function windowChipNote(window: UsageWindow, now: number): string {
  const remaining = clampPercent(100 - window.usedPercent);
  const reset = formatResetRemaining(window.resetAt, now);
  const resetSuffix = reset ? ` ⏱${reset}` : "";
  return `${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`;
}

export function buildProviderUsageChipNotes(
  snapshot: ProviderUsageSnapshot,
  opts?: { now?: number },
): string[] {
  const now = opts?.now ?? Date.now();
  const notes: string[] = [];
  if (snapshot.error && !IGNORED_ERRORS.has(snapshot.error)) {
    notes.push(snapshot.error);
  }
  for (const window of snapshot.windows) {
    notes.push(windowChipNote(window, now));
  }
  if (snapshot.plan && snapshot.windows.length === 0 && !snapshot.error) {
    notes.push(`plan: ${snapshot.plan}`);
  }
  return notes;
}
