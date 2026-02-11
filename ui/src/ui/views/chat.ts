import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ModelSelectionInfo } from "../app-tool-stream.ts";
import type { SessionsListResult } from "../types.ts";
import type { ChatAttachment, ChatQueueItem, TaskPlan, TaskPlanStatus } from "../ui-types.ts";
import { extractTextCached } from "../chat/message-extract.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  modelSelection?: ModelSelectionInfo | null;
  taskPlan?: TaskPlan | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Subagent monitoring (spawnedBy=sessionKey)
  subagentMonitorLoading?: boolean;
  subagentMonitorResult?: SessionsListResult | null;
  subagentMonitorError?: string | null;
  onSubagentRefresh?: () => void;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onQueue?: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewChat: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  // Spark voice mic
  sparkVoiceAvailable?: boolean;
  sparkMicRecording?: boolean;
  onMicClick?: () => void;
  // Per-message actions (speaker = DGX TTS, copy = clipboard)
  onSpeakClick?: (text: string) => void;
  // TTS playback progress and stop
  ttsSpeaking?: boolean;
  ttsProgress?: string | null;
  onStopSpeaking?: () => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

type ImageBlock = {
  url: string;
  alt?: string;
};

type TaskProgress = {
  done: number;
  total: number;
  pct: number;
};

function normalizeTaskStatus(raw: unknown): TaskPlanStatus {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "running" || value === "done" || value === "blocked" || value === "skipped") {
    return value;
  }
  return "todo";
}

function computeTaskProgress(plan: TaskPlan | null | undefined): TaskProgress {
  const tasks = plan?.tasks ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => {
    const status = normalizeTaskStatus(t.status);
    return status === "done" || status === "skipped";
  }).length;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
  return { done, total, pct };
}

function taskStatusLabel(status: TaskPlanStatus): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "done") {
    return "Done";
  }
  if (status === "blocked") {
    return "Blocked";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  return "Todo";
}

function renderTaskStatusIcon(status: TaskPlanStatus) {
  if (status === "running") {
    return html`<span class="agent-task__icon agent-spin">${icons.loader}</span>`;
  }
  if (status === "done") {
    return html`<span class="agent-task__icon">${icons.check}</span>`;
  }
  if (status === "blocked") {
    return html`<span class="agent-task__icon">${icons.zap}</span>`;
  }
  if (status === "skipped") {
    return html`<span class="agent-task__icon">${icons.x}</span>`;
  }
  return html`
    <span class="agent-task__dot" aria-hidden="true"></span>
  `;
}

type TerminalItem =
  | {
      kind: "message";
      key: string;
      role: string;
      who: string;
      ts: number | null;
      text: string;
      images: ImageBlock[];
    }
  | {
      kind: "tool";
      key: string;
      ts: number | null;
      toolName: string;
      args: unknown;
      output: string | null;
    }
  | {
      kind: "stream";
      key: string;
      ts: number | null;
      who: string;
      text: string | null;
      empty: boolean;
    };

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function formatClock(ts: number | null) {
  if (!ts) {
    return "";
  }
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatAge(ts: number | null): string {
  if (!ts) {
    return "";
  }
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) {
    return "0s";
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) {
    return `${Math.max(1, sec)}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function truncate(text: string, maxChars: number) {
  const raw = text ?? "";
  if (raw.length <= maxChars) {
    return raw;
  }
  const suffix = "...";
  const sliceTo = Math.max(0, maxChars - suffix.length);
  return `${raw.slice(0, sliceTo)}${suffix}`;
}

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Gateway + UI format: { type:"image", source:{ type:"base64", media_type, data } }
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data;
          const mediaType = (source.media_type as string) || "image/png";
          const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  if (status.active) {
    return html`
      <div class="callout info agent-compaction-indicator agent-compaction-indicator--active">
        <span class="agent-compaction-indicator__icon agent-compaction-indicator__icon--spin">
          ${icons.loader}
        </span>
        <span>Compacting context...</span>
      </div>
    `;
  }

  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success agent-compaction-indicator agent-compaction-indicator--complete">
          ${icons.check}
          <span>Context compacted</span>
        </div>
      `;
    }
  }

  return nothing;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

function renderModelAttribution(selection: ModelSelectionInfo | null | undefined) {
  if (!selection) {
    return nothing;
  }
  const modelFull = `${selection.provider}/${selection.model}`;
  const think =
    selection.thinkLevel && selection.thinkLevel !== "off" ? selection.thinkLevel : null;
  return html`
    <div class="agent-meta-row" role="status" aria-live="polite">
      <span class="agent-meta-row__label">Model</span>
      <span class="mono agent-meta-row__value">${modelFull}</span>
      ${think ? html`<span class="agent-meta-row__muted">(thinking: ${think})</span>` : nothing}
    </div>
  `;
}

function readMessageTimestamp(message: unknown): number | null {
  const m = message as Record<string, unknown>;
  if (typeof m.timestamp === "number") {
    return m.timestamp;
  }
  if (typeof m.ts === "number") {
    return m.ts;
  }
  return null;
}

function buildTerminalItems(props: ChatProps): TerminalItem[] {
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = props.showThinking && Array.isArray(props.toolMessages) ? props.toolMessages : [];

  const merged: Array<{ message: unknown; key: string; ts: number | null; order: number }> = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    merged.push({
      message: msg,
      key: messageKey(msg, i),
      ts: readMessageTimestamp(msg),
      order: i,
    });
  }
  for (let i = 0; i < tools.length; i++) {
    const msg = tools[i];
    merged.push({
      message: msg,
      key: messageKey(msg, i + history.length),
      ts: readMessageTimestamp(msg),
      order: i + history.length,
    });
  }

  merged.sort((a, b) => {
    if (a.ts != null && b.ts != null) {
      return a.ts - b.ts;
    }
    if (a.ts != null) {
      return -1;
    }
    if (b.ts != null) {
      return 1;
    }
    return a.order - b.order;
  });

  // Tool-call metadata is often emitted in a separate assistant message (toolUse) while the
  // tool output is persisted as a distinct toolResult message. Build a lookup so the UI can
  // render meaningful args/name even when only toolResult messages are present in history.
  const toolCallsById = new Map<string, { toolName?: string; args?: unknown }>();
  for (const entry of merged) {
    const m = entry.message as Record<string, unknown>;
    const topToolCallId =
      typeof m.toolCallId === "string"
        ? m.toolCallId.trim()
        : typeof m.tool_call_id === "string"
          ? m.tool_call_id.trim()
          : "";
    const content = m.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      const b = block as Record<string, unknown>;
      const t = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";
      const isToolCall =
        t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use";
      if (!isToolCall) {
        continue;
      }
      const idRaw = typeof b.id === "string" ? b.id : topToolCallId;
      const id = typeof idRaw === "string" ? idRaw.trim() : "";
      if (!id) {
        continue;
      }
      const toolName = typeof b.name === "string" ? b.name.trim() : undefined;
      const args = b.args ?? b.arguments ?? b.parameters;
      const existing = toolCallsById.get(id);
      if (existing) {
        if (!existing.toolName && toolName) {
          existing.toolName = toolName;
        }
        if (existing.args === undefined && args !== undefined) {
          existing.args = args;
        }
      } else {
        toolCallsById.set(id, { toolName, args });
      }
    }
  }

  const items: TerminalItem[] = [];
  for (const entry of merged) {
    const normalized = normalizeMessage(entry.message);
    const role = normalizeRoleForGrouping(normalized.role);

    if (role === "tool") {
      const raw = entry.message as Record<string, unknown>;
      const toolCall = normalized.content.find((c) => {
        const t = String(c.type ?? "").toLowerCase();
        return t === "toolcall" || t === "tool_call";
      });
      const toolResult = normalized.content.find((c) => {
        const t = String(c.type ?? "").toLowerCase();
        return t === "toolresult" || t === "tool_result";
      });
      const toolCallId =
        typeof raw.toolCallId === "string"
          ? raw.toolCallId.trim()
          : typeof raw.tool_call_id === "string"
            ? raw.tool_call_id.trim()
            : "";
      const mapped = toolCallId ? toolCallsById.get(toolCallId) : undefined;

      const toolName =
        toolCall?.name?.trim() ||
        toolResult?.name?.trim() ||
        (typeof raw.toolName === "string" ? raw.toolName.trim() : "") ||
        (typeof raw.tool_name === "string" ? raw.tool_name.trim() : "") ||
        mapped?.toolName?.trim() ||
        "tool";

      const rawArgs =
        (raw as { args?: unknown }).args ?? (raw as { arguments?: unknown }).arguments;
      const args = toolCall?.args ?? rawArgs ?? mapped?.args ?? {};
      const output = (() => {
        if (typeof toolResult?.text === "string" && toolResult.text.trim()) {
          return toolResult.text;
        }
        const rawText = extractTextCached(entry.message);
        if (typeof rawText === "string" && rawText.trim()) {
          return rawText;
        }
        return null;
      })();

      items.push({
        kind: "tool",
        key: entry.key,
        ts: entry.ts ?? null,
        toolName,
        args,
        output,
      });
      continue;
    }

    const rawText = extractTextCached(entry.message);
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const images = extractImages(entry.message);
    if (!text && images.length === 0) {
      continue;
    }

    const who =
      role === "user"
        ? "YOU"
        : role === "assistant"
          ? "AGENT"
          : role === "system"
            ? "SYS"
            : String(role || "OTHER").toUpperCase();

    items.push({
      kind: "message",
      key: entry.key,
      role,
      who,
      ts: entry.ts ?? null,
      text,
      images,
    });
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const trimmed = props.stream.trim();
    const empty = trimmed.length === 0;
    items.push({
      kind: "stream",
      key,
      ts: props.streamStartedAt ?? null,
      who: "AGENT",
      text: empty ? null : props.stream,
      empty,
    });
  }

  return items;
}

function renderTerminalEntry(props: ChatProps, item: TerminalItem): TemplateResult {
  function renderAssistantActions(text: string, sparkAvailable: boolean) {
    const hasText = typeof text === "string" && text.trim().length > 0;
    if (!hasText) {
      return nothing;
    }
    return html`
      <div class="terminal-entry__actions">
        <button
          class="btn btn--icon btn--sm terminal-entry__action terminal-entry__action--copy"
          type="button"
          title="Copy message"
          aria-label="Copy message"
          @click=${async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement | null;
            if (!btn || btn.dataset.copying === "1") {
              return;
            }
            btn.dataset.copying = "1";
            btn.disabled = true;
            try {
              await navigator.clipboard.writeText(text.trim());
              if (!btn.isConnected) {
                return;
              }
              btn.dataset.copied = "1";
              btn.title = "Copied";
              btn.setAttribute("aria-label", "Copied");
              setTimeout(() => {
                if (!btn.isConnected) {
                  return;
                }
                delete btn.dataset.copied;
                delete btn.dataset.copying;
                btn.disabled = false;
                btn.title = "Copy message";
                btn.setAttribute("aria-label", "Copy message");
              }, 1500);
            } catch {
              if (btn.isConnected) {
                delete btn.dataset.copying;
                btn.disabled = false;
              }
            }
          }}
        >
          <span class="terminal-entry__action-icon" aria-hidden="true">
            <span class="terminal-entry__action-icon-copy">${icons.copy}</span>
            <span class="terminal-entry__action-icon-check">${icons.check}</span>
          </span>
        </button>
        ${
          sparkAvailable
            ? html`
              <button
                class="btn btn--icon btn--sm terminal-entry__action"
                type="button"
                title="Speak with DGX TTS"
                aria-label="Speak"
                @click=${() => props.onSpeakClick?.(text.trim())}
              >
                ${icons.speaker}
              </button>
            `
            : nothing
        }
      </div>
    `;
  }

  if (item.kind === "stream") {
    const sparkAvailable = Boolean(props.sparkVoiceAvailable);
    return html`
      <div class="terminal-entry terminal-entry--assistant terminal-entry--streaming">
        <div class="terminal-entry__meta">
          <span class="terminal-entry__role">${item.who}</span>
          <span class="terminal-entry__time">${formatClock(item.ts)}</span>
          <span class="terminal-entry__badge">LIVE</span>
          ${renderAssistantActions(item.text, sparkAvailable)}
        </div>
        <div class="terminal-entry__body">
          ${
            item.empty
              ? html`
                  <div class="terminal-reading" aria-label="Agent is thinking">
                    <span class="terminal-reading__dots"><span></span><span></span><span></span></span>
                  </div>
                `
              : html`
                  <pre class="terminal-pre terminal-pre--stream">
${item.text}<span class="terminal-cursor" aria-hidden="true"></span></pre>
                `
          }
        </div>
      </div>
    `;
  }

  if (item.kind === "tool") {
    const argsText = (() => {
      try {
        return JSON.stringify(item.args ?? {}, null, 2);
      } catch {
        if (item.args == null) {
          return "";
        }
        if (typeof item.args === "string") {
          return item.args;
        }
        return "[unserializable args]";
      }
    })();
    const output = item.output ?? "";
    const outputPreview = output ? truncate(output, 2400) : "";
    const canOpen = Boolean(props.onOpenSidebar && output);
    return html`
      <div class="terminal-entry terminal-entry--tool">
        <div class="terminal-entry__meta">
          <span class="terminal-entry__role">TOOL</span>
          <span class="terminal-entry__time">${formatClock(item.ts)}</span>
          <span class="terminal-entry__toolName mono">${item.toolName}</span>
          ${
            canOpen
              ? html`
                <button
                  class="btn btn--sm terminal-entry__open"
                  type="button"
                  @click=${() => {
                    if (!props.onOpenSidebar || !item.output) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${item.output}\n\`\`\``);
                  }}
                >
                  View
                </button>
              `
              : nothing
          }
        </div>
        <div class="terminal-entry__body">
          <details class="terminal-details" open>
            <summary class="terminal-details__summary">Arguments</summary>
            <pre class="terminal-pre terminal-pre--code">${argsText}</pre>
          </details>
          ${
            output
              ? html`
                  <details class="terminal-details">
                    <summary class="terminal-details__summary">
                      Output ${
                        outputPreview !== output
                          ? html`
                              <span class="muted">(truncated)</span>
                            `
                          : nothing
                      }
                    </summary>
                    <pre class="terminal-pre terminal-pre--code">${outputPreview}</pre>
                  </details>
                `
              : html`
                  <div class="muted terminal-entry__muted">No output yet.</div>
                `
          }
        </div>
      </div>
    `;
  }

  const roleClass =
    item.role === "assistant"
      ? "assistant"
      : item.role === "user"
        ? "user"
        : item.role === "system"
          ? "system"
          : "other";

  const body =
    item.role === "assistant"
      ? html`<div class="chat-text terminal-md">${unsafeHTML(toSanitizedMarkdownHtml(item.text))}</div>`
      : html`<pre class="terminal-pre">${item.text}</pre>`;

  const assistantActions =
    item.role === "assistant"
      ? renderAssistantActions(item.text, Boolean(props.sparkVoiceAvailable))
      : nothing;

  return html`
    <div class="terminal-entry terminal-entry--${roleClass}">
      <div class="terminal-entry__meta">
        <span class="terminal-entry__role">${item.who}</span>
        <span class="terminal-entry__time">${formatClock(item.ts)}</span>
        ${assistantActions}
      </div>
      <div class="terminal-entry__body">
        ${
          item.images.length
            ? html`
                <div class="terminal-images">
                  ${item.images.map(
                    (img) => html`
                      <img
                        src=${img.url}
                        alt=${img.alt ?? "Attached image"}
                        class="terminal-images__img"
                        @click=${() => window.open(img.url, "_blank")}
                      />
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${body}
      </div>
    </div>
  `;
}

function renderOrchestrationCard(props: ChatProps) {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const title =
    activeSession?.label?.trim() ||
    activeSession?.derivedTitle?.trim() ||
    activeSession?.displayName?.trim() ||
    props.sessionKey;

  const isStreaming = props.stream !== null;
  const isCompacting = Boolean(props.compactionStatus?.active);
  const statusLabel = isCompacting ? "Compacting" : isStreaming ? "Running" : "Idle";
  const statusDotClass = isStreaming ? "ok" : isCompacting ? "" : "neutral";

  const subagents = props.subagentMonitorResult?.sessions ?? [];
  const subagentError = props.subagentMonitorError ?? null;
  const subagentLoading = Boolean(props.subagentMonitorLoading);
  const canRefresh = Boolean(props.onSubagentRefresh);

  const plan = props.taskPlan ?? null;
  const tasks = plan?.tasks ?? [];
  const progress = computeTaskProgress(plan);
  const subagentByKey = new Map(subagents.map((s) => [s.key, s]));
  const subagentStatusByKey = (() => {
    const priority: Record<TaskPlanStatus, number> = {
      running: 5,
      blocked: 4,
      todo: 3,
      done: 2,
      skipped: 1,
    };
    const map = new Map<string, TaskPlanStatus>();
    for (const task of tasks) {
      const key = (task.assignedSessionKey ?? "").trim();
      if (!key) {
        continue;
      }
      const status = normalizeTaskStatus(task.status);
      const existing = map.get(key);
      if (!existing || priority[status] > priority[existing]) {
        map.set(key, status);
      }
    }
    return map;
  })();

  return html`
    <section class="card agent-orchestration" aria-label="Agent orchestration">
      <div class="agent-orchestration__header">
        <div class="agent-orchestration__titleBlock">
          <div class="card-title">Agent Orchestration</div>
          <div class="agent-orchestration__subtitle">
            <span class="mono">${title}</span>
          </div>
        </div>

        <div class="agent-orchestration__actions">
          <div class="pill agent-orchestration__statusPill" title=${statusLabel}>
            <span class="statusDot ${statusDotClass}"></span>
            <span>Status</span>
            <span class="mono">${statusLabel}</span>
          </div>
          ${
            canRefresh
              ? html`
                  <button
                    class="btn btn--sm agent-orchestration__refresh"
                    type="button"
                    ?disabled=${!props.connected || subagentLoading}
                    @click=${() => props.onSubagentRefresh?.()}
                    title="Refresh subagents"
                  >
                    <span class="${subagentLoading ? "agent-spin" : ""}">${icons.loader}</span>
                    Refresh
                  </button>
                `
              : nothing
          }
        </div>
      </div>

      <div class="agent-progress-wrap">
        <div
          class="agent-progress"
          role="progressbar"
          aria-label="Task progress"
          aria-valuemin="0"
          aria-valuemax=${String(progress.total)}
          aria-valuenow=${String(progress.done)}
        >
          <div class="agent-progress__fill" style=${`width: ${progress.pct}%`}></div>
          <div
            class="agent-progress__bar ${isStreaming || isCompacting ? "agent-progress__bar--active" : ""}"
          ></div>
        </div>
        <div class="agent-progress-meta">
          <span class="agent-progress-meta__label">Progress</span>
          <span class="mono agent-progress-meta__value">
            ${progress.total > 0 ? `${progress.done}/${progress.total}` : "—"}
          </span>
        </div>
      </div>

      <div class="agent-orchestration__meta">
        ${renderModelAttribution(props.modelSelection)}
        <div class="agent-meta-row">
          <span class="agent-meta-row__label">Session</span>
          <span class="mono agent-meta-row__value">${props.sessionKey}</span>
        </div>
        ${
          props.queue.length
            ? html`
                <div class="agent-meta-row">
                  <span class="agent-meta-row__label">Queued</span>
                  <span class="mono agent-meta-row__value">${props.queue.length}</span>
                </div>
              `
            : nothing
        }
      </div>

      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        plan && (tasks.length > 0 || plan.goal)
          ? html`
              <div class="agent-plan" aria-label="Task plan">
                <div class="agent-plan__header">
                  <div class="agent-plan__title">
                    Tasks
                    ${
                      tasks.length > 0
                        ? html`
                            <span class="agent-plan__count mono">
                              ${progress.done}/${progress.total}
                            </span>
                          `
                        : nothing
                    }
                  </div>
                  ${
                    plan.goal
                      ? html`<div class="agent-plan__goal muted">${plan.goal}</div>`
                      : nothing
                  }
                </div>
                ${
                  tasks.length > 0
                    ? html`
                        <div class="agent-plan__list" role="list">
                          ${tasks.map((task) => {
                            const status = normalizeTaskStatus(task.status);
                            const assignedKey = (task.assignedSessionKey ?? "").trim();
                            const assigned = assignedKey
                              ? subagentByKey.get(assignedKey)
                              : undefined;
                            const canOpenAssigned = Boolean(assigned);
                            const assignedLabel =
                              assigned?.label?.trim() ||
                              assigned?.derivedTitle?.trim() ||
                              assigned?.displayName?.trim() ||
                              assigned?.key ||
                              assignedKey;
                            const updatedAt =
                              typeof assigned?.updatedAt === "number" ? assigned.updatedAt : null;
                            return html`
                              <div class="agent-task agent-task--${status}" role="listitem">
                                <div class="agent-task__status" title=${taskStatusLabel(status)}>
                                  ${renderTaskStatusIcon(status)}
                                </div>
                                <div class="agent-task__main">
                                  <div class="agent-task__title">${task.title}</div>
                                  ${
                                    task.detail
                                      ? html`<div class="agent-task__detail muted">${task.detail}</div>`
                                      : nothing
                                  }
                                  ${
                                    assignedKey
                                      ? html`
                                          <button
                                            class="agent-task__assigned"
                                            type="button"
                                            ?disabled=${!canOpenAssigned}
                                            @click=${() => {
                                              if (!canOpenAssigned) {
                                                return;
                                              }
                                              props.onSessionKeyChange(assignedKey);
                                            }}
                                            title=${
                                              canOpenAssigned
                                                ? "Open assigned subagent"
                                                : "Assigned subagent was pruned"
                                            }
                                          >
                                            <span class="mono agent-task__assignedKey">
                                              ${assignedLabel}
                                            </span>
                                            <span class="agent-task__assignedAge mono">
                                              ${formatAge(updatedAt)}
                                            </span>
                                            ${
                                              !canOpenAssigned
                                                ? html`
                                                    <span class="muted agent-task__assignedMissing">(pruned)</span>
                                                  `
                                                : nothing
                                            }
                                          </button>
                                        `
                                      : nothing
                                  }
                                </div>
                              </div>
                            `;
                          })}
                        </div>
                      `
                    : html`
                        <div class="muted agent-plan__empty">No tasks yet.</div>
                      `
                }
              </div>
            `
          : isStreaming
            ? html`
                <div class="muted agent-plan__empty">Waiting for task plan...</div>
              `
            : nothing
      }

      ${
        props.queue.length
          ? html`
              <div class="agent-queue">
                <div class="agent-queue__title">Queued Messages</div>
                <div class="agent-queue__list">
                  ${props.queue.map(
                    (item) => html`
                      <div class="agent-queue__item">
                        <div class="agent-queue__text">
                          ${
                            item.text ||
                            (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                          }
                        </div>
                        <button
                          class="btn btn--sm agent-queue__remove"
                          type="button"
                          aria-label="Remove queued message"
                          @click=${() => props.onQueueRemove(item.id)}
                        >
                          ${icons.x}
                        </button>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing
      }

      <div class="agent-subagents">
        <div class="agent-subagents__header">
          <div class="agent-subagents__title">
            Subagents
            <span class="agent-subagents__count mono">${subagents.length}</span>
          </div>
          <div class="agent-subagents__hint muted">spawned by this thread</div>
        </div>

        ${subagentError ? html`<div class="callout danger">${subagentError}</div>` : nothing}

        ${
          !props.connected
            ? html`
                <div class="muted">Connect to see subagents.</div>
              `
            : subagentLoading && subagents.length === 0
              ? html`
                  <div class="muted">Loading subagents...</div>
                `
              : subagents.length === 0
                ? html`
                    <div class="muted">No subagents yet.</div>
                  `
                : html`
                    <div class="agent-subagents__list">
                      ${subagents.map((s) => {
                        const label =
                          s.label?.trim() ||
                          s.derivedTitle?.trim() ||
                          s.displayName?.trim() ||
                          s.key;
                        const updatedAt = typeof s.updatedAt === "number" ? s.updatedAt : null;
                        const preview = (s.lastMessagePreview ?? "").trim();
                        const hasPreview = Boolean(preview);
                        const status = subagentStatusByKey.get(s.key);
                        const dotStatus =
                          status === "running"
                            ? "running"
                            : status === "blocked"
                              ? "blocked"
                              : status === "done" || status === "skipped"
                                ? "done"
                                : status === "todo"
                                  ? "todo"
                                  : "neutral";
                        return html`
                          <button
                            class="agent-subagent"
                            type="button"
                            @click=${() => props.onSessionKeyChange(s.key)}
                            title="Open subagent session"
                          >
                            <div class="agent-subagent__main">
                              <div class="agent-subagent__title">
                                <span
                                  class="agent-subagent__dot agent-subagent__dot--${dotStatus}"
                                  aria-hidden="true"
                                ></span>
                                <span class="agent-subagent__titleText">${label}</span>
                              </div>
                              <div class="agent-subagent__sub">
                                <div
                                  class="agent-subagent__preview ${hasPreview ? "" : "agent-subagent__preview--empty"}"
                                >
                                  ${hasPreview ? preview : "No messages yet"}
                                </div>
                              </div>
                            </div>
                            <div class="agent-subagent__meta">
                              <div class="agent-subagent__time mono">
                                ${formatAge(updatedAt)}
                              </div>
                            </div>
                          </button>
                        `;
                      })}
                    </div>
                  `
        }
      </div>
    </section>
  `;
}

function renderTerminalCard(props: ChatProps) {
  const canCompose = props.connected;
  const isRunning = props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const canQueue =
    Boolean(props.onQueue) &&
    (props.draft.trim().length > 0 || (props.attachments?.length ?? 0) > 0);

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? isRunning
      ? hasAttachments
        ? "Agent is running (attachments will be queued)..."
        : "Steer the agent (↩ to inject, Shift+↩ for line breaks)"
      : hasAttachments
        ? "Add a message or paste more images..."
        : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting...";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);

  const thread = html`
    <div
      class="chat-thread terminal-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat...</div>
            `
          : nothing
      }
      ${repeat(
        buildTerminalItems(props),
        (item) => item.key,
        (item) => renderTerminalEntry(props, item),
      )}
    </div>
  `;

  return html`
    <section class="card agent-terminal" aria-label="Agent terminal">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
              <button
                class="chat-focus-exit"
                type="button"
                @click=${props.onToggleFocusMode}
                aria-label="Exit focus mode"
                title="Exit focus mode"
              >
                ${icons.x}
              </button>
            `
          : nothing
      }

      <div class="agent-terminal__header">
        <div class="agent-terminal__title">
          <div class="card-title">Agent Terminal</div>
          <div class="agent-terminal__subtitle muted">
            ${isRunning ? "Streaming" : "Ready"} · <span class="mono">${props.sessionKey}</span>
          </div>
          ${props.error ? html`<div class="agent-terminal__run-status" role="alert">Run failed: ${props.error}</div>` : nothing}
        </div>
        <div class="agent-terminal__actions">
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${!props.connected || (!canAbort && props.sending)}
            @click=${canAbort ? props.onAbort : props.onNewChat}
          >
            ${canAbort ? "Stop" : "New chat"}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${!props.connected}
            @click=${props.onRefresh}
            title="Refresh"
          >
            ${icons.loader}
            Refresh
          </button>
        </div>
      </div>

      <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
                <resizable-divider
                  .splitRatio=${splitRatio}
                  @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                ></resizable-divider>
                <div class="chat-sidebar">
                  ${renderMarkdownSidebar({
                    content: props.sidebarContent ?? null,
                    error: props.sidebarError ?? null,
                    onClose: props.onCloseSidebar!,
                    onViewRawText: () => {
                      if (!props.sidebarContent || !props.onOpenSidebar) {
                        return;
                      }
                      props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                    },
                  })}
                </div>
              `
            : nothing
        }
      </div>

      <div class="chat-compose agent-terminal__compose">
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span class="agent-terminal__composeLabel">${isRunning ? "Steer" : "Message"}</span>
            <textarea
              ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
              .value=${props.draft}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                }
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                props.onDraftChange(target.value);
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            ${
              props.ttsSpeaking && props.onStopSpeaking
                ? html`
                    <button
                      class="btn"
                      type="button"
                      @click=${() => props.onStopSpeaking?.()}
                      title="Stop speaking"
                      aria-label="Stop speaking"
                    >
                      Stop
                    </button>
                  `
                : nothing
            }
            ${
              isRunning && props.onQueue && !props.ttsSpeaking
                ? html`
                    <button
                      class="btn"
                      type="button"
                      ?disabled=${!props.connected || !canQueue}
                      @click=${() => props.onQueue?.()}
                      title="Queue message to send after the run finishes"
                    >
                      Queue
                    </button>
                  `
                : nothing
            }
            <button
              class="btn agent-terminal__mic ${!props.sparkVoiceAvailable ? "agent-terminal__mic--unavailable" : "agent-terminal__mic--available"} ${props.sparkMicRecording ? "agent-terminal__mic--recording" : ""}"
              ?hidden=${props.ttsSpeaking}
              type="button"
              ?disabled=${!props.connected}
              @click=${() => props.onMicClick?.()}
              title=${
                props.sparkVoiceAvailable
                  ? props.sparkMicRecording
                    ? "Stop recording"
                    : "Voice input (Spark STT)"
                  : "Spark unavailable"
              }
              aria-label=${
                props.sparkVoiceAvailable
                  ? props.sparkMicRecording
                    ? "Stop recording"
                    : "Start voice input"
                  : "Voice input unavailable (Spark down)"
              }
            >
              ${icons.mic}
            </button>
            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${props.onSend}
              title=${isRunning ? "Steer the running agent" : "Send message"}
            >
              ${isRunning ? "Steer" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderChat(props: ChatProps) {
  const showOrchestration = !props.focusMode;

  return html`
    <section class="agent-workspace ${showOrchestration ? "" : "agent-workspace--solo"}">
      ${showOrchestration ? renderOrchestrationCard(props) : nothing}
      ${renderTerminalCard(props)}
    </section>
  `;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
