import { clampPercent } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

function formatResetRemaining(targetMs?: number, now?: number): string | null {
  if (!targetMs) {
    return null;
  }
  const base = now ?? Date.now();
  const diffMs = targetMs - base;
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

function formatUsageNotes(snapshot: ProviderUsageSnapshot): string[] {
  return (snapshot.notes ?? []).map((note) => note.trim()).filter(Boolean);
}

export function resolveUsageSummaryMaxWindows(snapshot: ProviderUsageSnapshot): number {
  if (snapshot.provider === "anthropic") {
    return Math.min(Math.max(snapshot.windows.length, 1), 4);
  }
  return 2;
}

export function formatUsageWindowSummary(
  snapshot: ProviderUsageSnapshot,
  opts?: { now?: number; maxWindows?: number; includeResets?: boolean },
): string | null {
  if (snapshot.error) {
    return null;
  }
  if (snapshot.windows.length === 0 && formatUsageNotes(snapshot).length === 0) {
    return null;
  }
  const now = opts?.now ?? Date.now();
  const maxWindows =
    typeof opts?.maxWindows === "number" && opts.maxWindows > 0
      ? Math.min(opts.maxWindows, snapshot.windows.length)
      : snapshot.windows.length;
  const includeResets = opts?.includeResets ?? false;
  const windows = snapshot.windows.slice(0, maxWindows);
  const parts = windows.map((window) => {
    const remaining = clampPercent(100 - window.usedPercent);
    const reset = includeResets ? formatResetRemaining(window.resetAt, now) : null;
    const resetSuffix = reset ? ` ⏱${reset}` : "";
    return `${window.label} ${remaining.toFixed(0)}% left${resetSuffix}`;
  });
  parts.push(...formatUsageNotes(snapshot));
  return parts.join(" · ");
}

export function formatUsageSummaryLine(
  summary: UsageSummary,
  opts?: { now?: number; maxProviders?: number },
): string | null {
  const providers = summary.providers
    .filter((entry) => entry.windows.length > 0 && !entry.error)
    .slice(0, opts?.maxProviders ?? summary.providers.length);
  if (providers.length === 0) {
    return null;
  }

  const parts = providers.map((entry) => {
    const window = entry.windows.reduce((best, next) =>
      next.usedPercent > best.usedPercent ? next : best,
    );
    const notes = formatUsageNotes(entry);
    const remaining = clampPercent(100 - window.usedPercent);
    const reset = formatResetRemaining(window.resetAt, opts?.now);
    const resetSuffix = reset ? ` ⏱${reset}` : "";
    const note = notes[0];
    const noteSuffix = note ? `, ${note}` : "";
    const detail = `${remaining.toFixed(0)}% left (${window.label}${resetSuffix}${noteSuffix})`;
    return `${entry.displayName} ${detail}`;
  });
  return `📊 Usage: ${parts.join(" · ")}`;
}

export function formatUsageReportLines(summary: UsageSummary, opts?: { now?: number }): string[] {
  if (summary.providers.length === 0) {
    return ["Usage: no provider usage available."];
  }

  const lines: string[] = ["Usage:"];
  for (const entry of summary.providers) {
    const planSuffix = entry.plan ? ` (${entry.plan})` : "";
    if (entry.error) {
      lines.push(`  ${entry.displayName}${planSuffix}: ${entry.error}`);
      continue;
    }
    if (entry.windows.length === 0) {
      const notes = formatUsageNotes(entry);
      lines.push(`  ${entry.displayName}${planSuffix}: ${notes[0] ?? "no data"}`);
      for (const note of notes.slice(1)) {
        lines.push(`    note: ${note}`);
      }
      continue;
    }
    lines.push(`  ${entry.displayName}${planSuffix}`);
    for (const window of entry.windows) {
      const remaining = clampPercent(100 - window.usedPercent);
      const reset = formatResetRemaining(window.resetAt, opts?.now);
      const resetSuffix = reset ? ` · resets ${reset}` : "";
      lines.push(`    ${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`);
    }
    for (const note of formatUsageNotes(entry)) {
      lines.push(`    note: ${note}`);
    }
  }
  return lines;
}
