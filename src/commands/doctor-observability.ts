import type { OpenClawConfig } from "../config/config.js";
import {
  inspectObservabilityFreshness,
  type ObservabilityFileStatus,
} from "../infra/observability-rollup.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

function formatFileStatus(status: ObservabilityFileStatus): string {
  if (!status.exists) {
    return `${shortenHomePath(status.path)} (missing)`;
  }
  const ageMinutes = Math.round((status.ageMs ?? 0) / 60000);
  const sizeKb = Math.max(1, Math.round((status.sizeBytes ?? 0) / 1024));
  return `${shortenHomePath(status.path)} (${ageMinutes}m old, ${sizeKb} KB)`;
}

export async function noteObservabilityHealth(params: {
  cfg: OpenClawConfig;
  maxStaleMs?: number;
}) {
  const freshness = await inspectObservabilityFreshness({
    cfg: params.cfg,
    maxStaleMs: params.maxStaleMs,
  });
  if (freshness.level === "ok") {
    return;
  }

  const lines = [
    freshness.summary,
    `- Gateway log: ${formatFileStatus(freshness.gatewayLog)}`,
    `- Event sink: ${formatFileStatus(freshness.eventsFile)}`,
    ...freshness.warnings.map((warning) => `- ${warning}`),
    '- Daily rollups read the canonical NDJSON sink under logs/events. Run "pnpm observability:check" or "pnpm observability:rollup -- --write" from a source checkout for a deeper operator report.',
  ];
  note(lines.join("\n"), "Observability");
}
