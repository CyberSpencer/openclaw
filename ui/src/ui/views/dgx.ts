import { html, nothing, type TemplateResult } from "lit";
import type { SparkStatus, SparkGpuStatus, SparkContainer } from "../types.js";
import { icons } from "../icons.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DgxProps = {
  connected: boolean;
  sparkStatus: SparkStatus | null;
  onRefresh: () => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ServiceEntry = {
  healthy?: boolean;
  status?: number;
  error?: string | null;
  latency_ms?: number;
};

function asServiceEntry(value: unknown): ServiceEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as ServiceEntry;
}

/** Human-friendly service names and descriptions. */
const SERVICE_META: Record<string, { label: string; sub: string; port?: number }> = {
  ollama: { label: "Ollama", sub: "LLM Runtime", port: 11434 },
  router: { label: "Router", sub: "Intent Routing", port: 8001 },
  qdrant: { label: "Qdrant", sub: "Vector DB", port: 6333 },
  embeddings: { label: "Embeddings", sub: "Qwen3 8B GPU", port: 8081 },
  personaplex: { label: "PersonaPlex", sub: "S2S Wrapper", port: 8998 },
  moshi: { label: "Moshi", sub: "Voice GPU", port: 8999 },
  voice_health: { label: "Voice Health", sub: "Aggregator", port: 9000 },
  voice_stt: { label: "Voice STT", sub: "Qwen3-ASR 1.7B", port: 9001 },
  voice_tts: { label: "Voice TTS", sub: "Qwen3-TTS 1.7B", port: 9002 },
};

const VOICE_KEYS = new Set(["voice_health", "voice_stt", "voice_tts"]);

function formatLatency(ms: number | undefined | null): string {
  if (ms == null) {
    return "";
  }
  return `${Math.round(ms)}ms`;
}

function formatMib(mib: number | undefined | null): string {
  if (mib == null) {
    return "n/a";
  }
  if (mib >= 1024) {
    return `${(mib / 1024).toFixed(1)} GiB`;
  }
  return `${Math.round(mib)} MiB`;
}

function overallBadgeClass(overall: string | undefined): string {
  if (!overall) {
    return "dgx-badge--neutral";
  }
  switch (overall) {
    case "healthy":
      return "dgx-badge--ok";
    case "degraded":
      return "dgx-badge--warn";
    case "down":
      return "dgx-badge--danger";
    default:
      return "dgx-badge--neutral";
  }
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

function renderServiceCard(name: string, svc: ServiceEntry): TemplateResult {
  const meta = SERVICE_META[name] ?? { label: name, sub: "" };
  const healthy = Boolean(svc.healthy);
  const latency = formatLatency(svc.latency_ms);
  const errorText = svc.error && !healthy ? String(svc.error) : null;

  return html`
    <div class="dgx-service-card ${healthy ? "" : "dgx-service-card--down"}">
      <div class="dgx-service-card__header">
        <span class="statusDot ${healthy ? "ok" : ""}"></span>
        ${meta.port ? html`<span class="dgx-service-card__port mono">:${meta.port}</span>` : nothing}
      </div>
      <div class="dgx-service-card__name">${meta.label}</div>
      <div class="dgx-service-card__sub">${meta.sub}</div>
      <div class="dgx-service-card__footer">
        ${latency ? html`<span class="mono dgx-service-card__latency">${latency}</span>` : nothing}
        ${errorText ? html`<span class="dgx-service-card__error">${errorText}</span>` : nothing}
      </div>
    </div>
  `;
}

function renderGpu(gpu: SparkGpuStatus): TemplateResult {
  const tempLabel = gpu.temperature_c != null ? `${gpu.temperature_c}\u00B0C` : null;
  const powerLabel = gpu.power_w != null ? `${gpu.power_w}W` : null;
  const usedLabel = formatMib(gpu.memory_used_mib);
  const totalMib = gpu.memory_total_mib && gpu.memory_total_mib > 0 ? gpu.memory_total_mib : null;
  const unifiedTag = gpu.unified_memory ? "Unified Memory" : null;

  // VRAM percentage (use total if available, otherwise estimate from processes)
  let vramPct = 0;
  if (totalMib && gpu.memory_used_mib) {
    vramPct = Math.min(100, Math.round((gpu.memory_used_mib / totalMib) * 100));
  }

  const utilPct = gpu.utilization_pct ?? 0;

  return html`
    <div class="card dgx-gpu-card">
      <div class="card-title">GPU Status</div>
      <div class="dgx-gpu-meta">
        <span class="mono">${gpu.name ?? "GPU"}</span>
        ${tempLabel ? html`<span class="dgx-gpu-meta__sep">&middot;</span><span class="mono">${tempLabel}</span>` : nothing}
        ${powerLabel ? html`<span class="dgx-gpu-meta__sep">&middot;</span><span class="mono">${powerLabel}</span>` : nothing}
        ${unifiedTag ? html`<span class="dgx-gpu-meta__sep">&middot;</span><span class="dgx-gpu-tag">${unifiedTag}</span>` : nothing}
      </div>

      <div class="dgx-gpu-bars">
        <div class="dgx-gpu-bar">
          <div class="dgx-gpu-bar__label">GPU Compute</div>
          <div class="dgx-gpu-bar__track">
            <div class="dgx-gpu-bar__fill dgx-gpu-bar__fill--compute" style="width: ${utilPct}%"></div>
          </div>
          <div class="dgx-gpu-bar__value mono">${utilPct}%</div>
        </div>
        <div class="dgx-gpu-bar">
          <div class="dgx-gpu-bar__label">VRAM</div>
          <div class="dgx-gpu-bar__track">
            <div class="dgx-gpu-bar__fill dgx-gpu-bar__fill--vram" style="width: ${vramPct}%"></div>
          </div>
          <div class="dgx-gpu-bar__value mono">${usedLabel}${totalMib ? ` (${vramPct}%)` : ""}</div>
        </div>
      </div>

      ${
        gpu.processes && gpu.processes.length > 0
          ? html`
              <div class="dgx-gpu-processes">
                ${gpu.processes.map(
                  (p) => html`
                    <div class="dgx-gpu-process">
                      <span class="mono">PID ${p.pid}</span>
                      <span class="muted">&mdash;</span>
                      <span class="muted">${p.process}</span>
                      <span class="mono dgx-gpu-process__mem">${formatMib(p.memory_mib)}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderContainers(containers: SparkContainer[]): TemplateResult {
  if (containers.length === 0) {
    return html`
      <div class="card">
        <div class="card-title">Container Resources</div>
        <div class="muted" style="margin-top: 10px">No containers reported.</div>
      </div>
    `;
  }

  return html`
    <div class="card dgx-containers-card">
      <div class="card-title">Container Resources</div>
      <div class="dgx-containers-table">
        <div class="dgx-containers-row dgx-containers-row--header">
          <span>Name</span>
          <span>CPU</span>
          <span>Memory</span>
          <span>Net I/O</span>
        </div>
        ${containers.map(
          (c) => html`
            <div class="dgx-containers-row">
              <span class="mono">${c.name}</span>
              <span class="mono">${c.cpu ?? "n/a"}</span>
              <span class="mono">${c.memory ?? "n/a"}</span>
              <span class="mono">${c.net_io ?? "n/a"}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderDgx(props: DgxProps): TemplateResult {
  const spark = props.sparkStatus;
  const enabled = spark?.enabled ?? false;
  const host = spark?.host ?? null;

  // Disconnected or DGX disabled
  if (!props.connected) {
    return html`
      <div class="dgx-empty">
        <div class="dgx-empty__icon">${icons.server}</div>
        <div class="dgx-empty__title">Not Connected</div>
        <div class="dgx-empty__sub">Connect to the gateway to view DGX Spark status.</div>
      </div>
    `;
  }

  if (!enabled) {
    return html`
      <div class="dgx-empty">
        <div class="dgx-empty__icon">${icons.server}</div>
        <div class="dgx-empty__title">DGX Spark Disabled</div>
        <div class="dgx-empty__sub">Set <code class="mono">DGX_ENABLED=1</code> and <code class="mono">DGX_HOST</code> in your workspace config to enable.</div>
      </div>
    `;
  }

  // Parse services
  const services = spark?.services ?? {};
  const serviceEntries = Object.entries(services);
  const coreServices: [string, ServiceEntry][] = [];
  const voiceServices: [string, ServiceEntry][] = [];

  for (const [name, raw] of serviceEntries) {
    const svc = asServiceEntry(raw);
    if (!svc) {
      continue;
    }
    if (VOICE_KEYS.has(name)) {
      voiceServices.push([name, svc]);
    } else {
      coreServices.push([name, svc]);
    }
  }

  const overall = spark?.overall ?? (spark?.active ? "healthy" : "down");
  const counts = spark?.counts;
  const checkedAt = spark?.checkedAt;
  const checkedLabel = checkedAt
    ? new Date(checkedAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const hasGpu = spark?.gpu && typeof spark.gpu === "object";
  const hasContainers = Array.isArray(spark?.containers) && spark.containers.length > 0;

  return html`
    <div class="dgx-dashboard">
      <!-- Header bar -->
      <div class="dgx-header">
        <div class="dgx-header__left">
          <span class="dgx-header__host mono">${host ?? "DGX Spark"}</span>
        </div>
        <div class="dgx-header__right">
          <span class="dgx-badge ${overallBadgeClass(overall)}">
            ${overall.toUpperCase()}${counts ? html` &mdash; ${counts.healthy}/${counts.total} services` : nothing}
          </span>
          ${checkedLabel ? html`<span class="muted">Updated: ${checkedLabel}</span>` : nothing}
          <button class="btn dgx-refresh-btn" @click=${() => props.onRefresh()} title="Refresh DGX status">
            ${icons.loader}
            Refresh
          </button>
        </div>
      </div>

      <!-- Core Services -->
      ${
        coreServices.length > 0
          ? html`
              <section class="dgx-section">
                <div class="dgx-section__title">Core Services</div>
                <div class="dgx-services-grid">
                  ${coreServices.map(([name, svc]) => renderServiceCard(name, svc))}
                </div>
              </section>
            `
          : nothing
      }

      <!-- Voice Pipeline -->
      ${
        voiceServices.length > 0
          ? html`
              <section class="dgx-section">
                <div class="dgx-section__title">
                  Voice Pipeline
                  <span class="dgx-section__badge">Standalone STT/TTS</span>
                </div>
                <div class="dgx-services-grid dgx-services-grid--voice">
                  ${voiceServices.map(([name, svc]) => renderServiceCard(name, svc))}
                </div>
              </section>
            `
          : nothing
      }

      <!-- GPU + Containers row -->
      ${
        hasGpu || hasContainers
          ? html`
              <div class="dgx-bottom-grid">
                ${hasGpu ? renderGpu(spark.gpu!) : nothing}
                ${hasContainers ? renderContainers(spark.containers!) : nothing}
              </div>
            `
          : nothing
      }
    </div>
  `;
}
