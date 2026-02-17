import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import type {
  OrchestrationBoard,
  OrchestrationCard,
  OrchestrationLane,
  OrchestrationLaneId,
  OrchestrationRunner,
  CodexMode,
} from "../orchestrator-store.ts";
import { truncateText } from "../format.ts";
import { icons } from "../icons.ts";
import {
  ORCHESTRATOR_TEMPLATES,
  hydrateTemplatePrompt,
  type OrchestratorTemplate,
} from "../orchestrator-templates.ts";

type OrchestratorHost = AppViewState & {
  orchBoards: OrchestrationBoard[];
  orchSelectedBoardId: string;
  orchSelectedCardId: string | null;
  orchDragOverLaneId: string | null;
  orchBusyCardId: string | null;
  orchTemplateQuery: string;
  orchDraft: {
    title: string;
    task: string;
    agentId: string;
    runner: OrchestrationRunner;
    model: string;
    thinking: string;
    timeoutSeconds: string;
    cleanup: "keep" | "delete";
    codexMode: CodexMode;
    codexShellAllowlist: string;
    showAdvanced: boolean;
  };
  orchSelectCard: (cardId: string | null) => void;
  orchCreateCard: (laneId?: OrchestrationLaneId) => void;
  orchUpdateCard: (cardId: string, patch: Partial<OrchestrationCard>) => void;
  orchMoveCard: (cardId: string, laneId: OrchestrationLaneId) => void;
  orchDeleteCard: (cardId: string) => void;
  orchDuplicateCard: (cardId: string) => void;
  orchRunCard: (cardId: string) => Promise<void>;
  orchCleanupCardSession: (cardId: string) => Promise<void>;
  orchSetDraft: (patch: Partial<OrchestratorHost["orchDraft"]>) => void;
  orchAddDraftCard: (opts?: { run?: boolean }) => Promise<void> | void;
  openChatSession: (sessionKey: string) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high"] as const;
const CODEX_MODES = ["plan", "apply", "run"] as const;

function resolveBoard(state: OrchestratorHost): OrchestrationBoard | null {
  const boards = state.orchBoards ?? [];
  if (boards.length === 0) {
    return null;
  }
  return boards.find((b) => b.id === state.orchSelectedBoardId) ?? boards[0] ?? null;
}

function resolveSelectedCard(
  board: OrchestrationBoard | null,
  selectedId: string | null,
): OrchestrationCard | null {
  if (!board || !selectedId) {
    return null;
  }
  return board.cards.find((c) => c.id === selectedId) ?? null;
}

function cardStatusLabel(card: OrchestrationCard): string {
  const status = card.run?.status ?? "idle";
  if (status === "accepted") {
    return "Queued";
  }
  if (status === "running") {
    return "Running";
  }
  if (status === "done") {
    return "Done";
  }
  if (status === "error") {
    return "Error";
  }
  return "Idle";
}

function isCardRunning(card: OrchestrationCard): boolean {
  const status = card.run?.status ?? "idle";
  return status === "accepted" || status === "running";
}

function cardPreviewText(card: OrchestrationCard): string {
  const last = card.run?.lastText?.trim();
  if (last) {
    return last;
  }
  return card.task.trim();
}

function matchesTemplateQuery(tpl: OrchestratorTemplate, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const hay = `${tpl.title} ${tpl.description} ${tpl.tags.join(" ")}`.toLowerCase();
  return query
    .split(/\s+/g)
    .filter(Boolean)
    .every((token) => hay.includes(token));
}

function applyTemplateToDraft(state: OrchestratorHost, tpl: OrchestratorTemplate) {
  const prompt = hydrateTemplatePrompt(tpl.prompt);
  const patch: Partial<OrchestratorHost["orchDraft"]> = {
    title: tpl.title,
    task: prompt,
  };

  if (tpl.agentId) {
    patch.agentId = tpl.agentId;
  }
  if (tpl.model !== undefined) {
    patch.model = tpl.model;
  }
  if (tpl.thinking !== undefined) {
    patch.thinking = tpl.thinking;
  }
  if (tpl.timeoutSeconds !== undefined) {
    patch.timeoutSeconds = String(tpl.timeoutSeconds);
  }
  if (tpl.cleanup !== undefined) {
    patch.cleanup = tpl.cleanup;
  }

  // If the template specifies any overrides, open Advanced by default.
  if (tpl.model || tpl.thinking || tpl.timeoutSeconds || tpl.cleanup) {
    patch.showAdvanced = true;
  }

  state.orchSetDraft(patch);
}

function agentOptions(state: OrchestratorHost) {
  const agents = state.agentsList?.agents ?? [];
  const fallback: Array<{ id: string; name?: string }> = [{ id: "main" }];
  const list: Array<{ id: string; name?: string }> = agents.length
    ? agents.map((agent) => ({ id: agent.id, name: agent.name }))
    : fallback;
  return list.map((a) => ({ id: a.id, label: a.name?.trim() ? `${a.name} (${a.id})` : a.id }));
}

function renderTemplateLibrary(state: OrchestratorHost) {
  const q = state.orchTemplateQuery ?? "";
  const templates = ORCHESTRATOR_TEMPLATES.filter((tpl) => matchesTemplateQuery(tpl, q));
  const countLabel = templates.length === 1 ? "1 template" : `${templates.length} templates`;
  const iconFor = (tpl: OrchestratorTemplate) =>
    icons[tpl.icon as keyof typeof icons] ?? icons.scrollText;

  return html`
    <section class="card orch-templates">
      <div class="orch-side-title">Templates</div>
      <div class="orch-side-sub">Start from a proven prompt, then customize before launch.</div>

      <div class="orch-templates__search" role="search">
        <span class="orch-templates__searchIcon" aria-hidden="true">${icons.search}</span>
        <input
          class="orch-templates__searchInput"
          type="search"
          placeholder="Search templates"
          .value=${q}
          @input=${(e: Event) => {
            state.orchTemplateQuery = (e.target as HTMLInputElement).value;
          }}
        />
        ${
          q.trim()
            ? html`
              <button
                class="btn btn--icon btn--sm orch-templates__clear"
                type="button"
                title="Clear search"
                aria-label="Clear search"
                @click=${() => {
                  state.orchTemplateQuery = "";
                }}
              >
                ${icons.x}
              </button>
            `
            : nothing
        }
      </div>

      <div class="orch-templates__meta muted">${countLabel}</div>

      <div class="orch-templates__list" role="list">
        ${templates.map(
          (tpl) => html`
            <div
              class="orch-template"
              role="button"
              tabindex="0"
              @click=${() => applyTemplateToDraft(state, tpl)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  applyTemplateToDraft(state, tpl);
                }
              }}
            >
              <div class="orch-template__icon" aria-hidden="true">${iconFor(tpl)}</div>
              <div class="orch-template__main">
                <div class="orch-template__title">${tpl.title}</div>
                <div class="orch-template__desc">${tpl.description}</div>
                <div class="orch-template__tags">
                  ${tpl.tags.slice(0, 4).map((tag) => html`<span class="pill">${tag}</span>`)}
                </div>
              </div>
              <div class="orch-template__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  @click=${(e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyTemplateToDraft(state, tpl);
                  }}
                >
                  Use
                </button>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  ?disabled=${!state.connected}
                  title=${state.connected ? "Create a task card and launch it" : "Connect to the gateway first"}
                  @click=${async (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyTemplateToDraft(state, tpl);
                    await state.orchAddDraftCard({ run: true });
                  }}
                >
                  ${icons.zap}
                  Launch
                </button>
              </div>
            </div>
          `,
        )}
        ${
          templates.length === 0
            ? html`
                <div class="orch-templates__empty muted">No templates match this search.</div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}

function renderLane(state: OrchestratorHost, board: OrchestrationBoard, lane: OrchestrationLane) {
  const cards = board.cards.filter((card) => card.laneId === lane.id);
  const count = cards.length;
  const isDrop = state.orchDragOverLaneId === lane.id;
  return html`
    <div
      class="orch-column ${isDrop ? "orch-column--drop" : ""}"
      data-lane=${lane.id}
      @dragover=${(e: DragEvent) => {
        e.preventDefault();
        if (state.orchDragOverLaneId !== lane.id) {
          state.orchDragOverLaneId = lane.id;
        }
      }}
      @dragleave=${() => {
        if (state.orchDragOverLaneId === lane.id) {
          state.orchDragOverLaneId = null;
        }
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        state.orchDragOverLaneId = null;
        const raw = e.dataTransfer?.getData("text/plain") ?? "";
        const cardId = raw.trim();
        if (!cardId) {
          return;
        }
        state.orchMoveCard(cardId, lane.id);
      }}
    >
      <div class="orch-column-head">
        <div>
          <div class="orch-column-title">${lane.title}</div>
          <div class="orch-column-meta">${count} card${count === 1 ? "" : "s"}</div>
        </div>
        <button
          class="btn btn--sm"
          title="Add a new card"
          @click=${() => state.orchCreateCard(lane.id)}
        >
          ${icons.penLine}
          New
        </button>
      </div>
      ${cards.map((card) => renderCard(state, card))}
    </div>
  `;
}

function renderCard(state: OrchestratorHost, card: OrchestrationCard) {
  const selected = state.orchSelectedCardId === card.id;
  const running = isCardRunning(card);
  const preview = truncateText(cardPreviewText(card), 160).text;
  const status = cardStatusLabel(card);
  const statusDotOk = card.run?.status === "done";
  const statusDotWarn = card.run?.status === "error";
  const dotClass = statusDotOk ? "ok" : statusDotWarn ? "" : running ? "ok" : "";
  return html`
    <div
      class="orch-card ${running ? "orch-card--running" : ""}"
      role="button"
      tabindex="0"
      aria-selected=${selected}
      draggable="true"
      @dragstart=${(e: DragEvent) => {
        state.orchSelectCard(card.id);
        e.dataTransfer?.setData("text/plain", card.id);
        e.dataTransfer?.setDragImage?.(e.currentTarget as Element, 12, 12);
      }}
      @click=${() => state.orchSelectCard(card.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          state.orchSelectCard(card.id);
        }
      }}
    >
      <div class="orch-card-title">${card.title}</div>
      <div class="orch-card-sub">${preview || "No task yet. Select to write the prompt."}</div>
      <div class="orch-card-meta">
        <span class="orch-badge" title="Agent id">
          <span class="statusDot ${running ? "ok" : ""}"></span>
          <span class="mono">${card.agentId || "main"}</span>
        </span>
        <span class="orch-badge" title="Run status">
          <span class="statusDot ${dotClass}"></span>
          <span>${status}</span>
        </span>
      </div>
    </div>
  `;
}

function renderLaunchpad(state: OrchestratorHost, board: OrchestrationBoard) {
  const agents = agentOptions(state);
  const connected = state.connected;
  const canLaunch = connected && state.orchDraft.task.trim().length > 0;
  const isCodex = state.orchDraft.runner === "codex";
  return html`
    <div class="stack orch-side-stack">
      ${renderTemplateLibrary(state)}

      <section class="card">
        <div class="orch-side-title">${isCodex ? "Launch Codex CLI" : "Launch Sub-Agent"}</div>
        <div class="orch-side-sub">
          ${
            isCodex
              ? "Create a task card, then run it via Codex CLI inside an isolated git worktree."
              : "Create a task card, then spawn it into an isolated sub-agent session."
          }
        </div>

        <div class="stack" style="margin-top: 14px;">
        <label class="field">
          <span>Title</span>
          <input
            .value=${state.orchDraft.title}
            placeholder="(optional) e.g. Audit auth flow"
            @input=${(e: Event) => state.orchSetDraft({ title: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>Runner</span>
          <select
            .value=${state.orchDraft.runner}
            @change=${(e: Event) =>
              state.orchSetDraft({
                runner: (e.target as HTMLSelectElement).value === "codex" ? "codex" : "subagent",
              })}
          >
            <option value="subagent">Sub-agent (OpenClaw)</option>
            <option value="codex">Codex CLI (worktree)</option>
          </select>
        </label>

        <label class="field">
          <span>${isCodex ? "Agent/Profile" : "Agent"}</span>
          <select
            .value=${state.orchDraft.agentId}
            @change=${(e: Event) => state.orchSetDraft({ agentId: (e.target as HTMLSelectElement).value })}
          >
            ${agents.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
          </select>
        </label>

        <label class="field">
          <span>Task Prompt</span>
          <textarea
            .value=${state.orchDraft.task}
            placeholder=${isCodex ? "What should Codex implement, exactly?" : "What should the sub-agent do, exactly?"}
            rows="6"
            @input=${(e: Event) => state.orchSetDraft({ task: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
        </label>

        <button
          class="btn ${state.orchDraft.showAdvanced ? "active" : ""}"
          type="button"
          @click=${() => state.orchSetDraft({ showAdvanced: !state.orchDraft.showAdvanced })}
          aria-expanded=${state.orchDraft.showAdvanced}
        >
          ${icons.sliders}
          Advanced
        </button>

        ${
          state.orchDraft.showAdvanced
            ? html`
                <div class="stack">
                  ${
                    isCodex
                      ? html`
                          <label class="field">
                            <span>Codex Mode</span>
                            <select
                              .value=${state.orchDraft.codexMode}
                              @change=${(e: Event) =>
                                state.orchSetDraft({
                                  codexMode: (e.target as HTMLSelectElement).value as CodexMode,
                                })}
                            >
                              ${CODEX_MODES.map((m) => html`<option value=${m}>${m}</option>`)}
                            </select>
                          </label>

                          <label class="field">
                            <span>Timeout (seconds)</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              .value=${state.orchDraft.timeoutSeconds}
                              placeholder="0"
                              @input=${(e: Event) =>
                                state.orchSetDraft({
                                  timeoutSeconds: (e.target as HTMLInputElement).value,
                                })}
                            />
                          </label>

                          <label class="field">
                            <span>Shell Allowlist (run mode)</span>
                            <textarea
                              .value=${state.orchDraft.codexShellAllowlist}
                              placeholder="One command per line, e.g.\npnpm --dir core test"
                              rows="5"
                              @input=${(e: Event) =>
                                state.orchSetDraft({
                                  codexShellAllowlist: (e.target as HTMLTextAreaElement).value,
                                })}
                            ></textarea>
                          </label>
                          <div class="muted">
                            Note: <span class="mono">run</span> mode requires a non-empty allowlist.
                          </div>
                        `
                      : html`
                          <label class="field">
                            <span>Model Override (optional)</span>
                            <input
                              .value=${state.orchDraft.model}
                              placeholder="openai-codex/gpt-5.3-codex"
                              @input=${(e: Event) =>
                                state.orchSetDraft({ model: (e.target as HTMLInputElement).value })}
                            />
                          </label>

                          <label class="field">
                            <span>Thinking</span>
                            <select
                              .value=${state.orchDraft.thinking}
                              @change=${(e: Event) =>
                                state.orchSetDraft({
                                  thinking: (e.target as HTMLSelectElement).value,
                                })}
                            >
                              ${THINK_LEVELS.map(
                                (level) =>
                                  html`<option value=${level}>${level ? level : "inherit"}</option>`,
                              )}
                            </select>
                          </label>

                          <label class="field">
                            <span>Timeout (seconds)</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              .value=${state.orchDraft.timeoutSeconds}
                              placeholder="0"
                              @input=${(e: Event) =>
                                state.orchSetDraft({
                                  timeoutSeconds: (e.target as HTMLInputElement).value,
                                })}
                            />
                          </label>

                          <label class="field">
                            <span>Cleanup</span>
                            <select
                              .value=${state.orchDraft.cleanup}
                              @change=${(e: Event) =>
                                state.orchSetDraft({
                                  cleanup:
                                    (e.target as HTMLSelectElement).value === "delete"
                                      ? "delete"
                                      : "keep",
                                })}
                            >
                              <option value="keep">Keep session</option>
                              <option value="delete">Delete session after completion</option>
                            </select>
                          </label>
                        `
                  }
                </div>
              `
            : nothing
        }

        <div class="orch-actions">
          <button
            class="btn"
            type="button"
            ?disabled=${!state.orchDraft.task.trim()}
            @click=${() => state.orchAddDraftCard({ run: false })}
            title="Create a card in the Backlog lane"
          >
            Add to Backlog
          </button>
          <button
            class="btn primary"
            type="button"
            ?disabled=${!canLaunch}
            @click=${() => state.orchAddDraftCard({ run: true })}
            title=${
              connected
                ? isCodex
                  ? "Run task via Codex CLI"
                  : "Spawn sub-agent run"
                : "Connect to the gateway first"
            }
          >
            ${icons.zap}
            Launch
          </button>
        </div>

        ${
          !connected
            ? html`
                <div class="callout" style="margin-top: 6px">
                  Connect the gateway in <span class="mono">Overview</span> to launch runs.
                </div>
              `
            : nothing
        }

        <div class="orch-divider"></div>

        <div class="muted">
          Tip: Keep the lanes honest. Running is automatic, but you decide what makes it Done.
        </div>

        <div class="muted" style="margin-top: 6px;">
          Board: <span class="mono">${board.title}</span> · Cards: ${board.cards.length}
        </div>
        </div>
      </section>
    </div>
  `;
}

function renderInspector(
  state: OrchestratorHost,
  board: OrchestrationBoard,
  card: OrchestrationCard,
) {
  const agents = agentOptions(state);
  const running = isCardRunning(card);
  const busy = state.orchBusyCardId === card.id;
  const isCodex = (card.runner ?? "subagent") === "codex";
  const run = card.run;
  const hasSession =
    Boolean(run?.sessionKey) && !String(run?.sessionKey ?? "").startsWith("codex:");
  const status = cardStatusLabel(card);
  const lastText = run?.lastText?.trim() || "";
  const cleanupStatus = run?.cleanup?.status ?? null;
  const autoDelete = run?.cleanup?.mode === "delete";
  const cleanupDisabled =
    autoDelete || !hasSession || cleanupStatus === "pending" || busy || !state.connected;

  const laneOptions = board.lanes.map((lane) => ({ id: lane.id, title: lane.title }));
  const timeoutValue =
    typeof card.timeoutSeconds === "number" && Number.isFinite(card.timeoutSeconds)
      ? String(Math.max(0, Math.floor(card.timeoutSeconds)))
      : "";

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="orch-side-title">Task Card</div>
          <div class="orch-side-sub">Edit, spawn, and inspect run output.</div>
        </div>
        <button class="btn btn--sm" type="button" @click=${() => state.orchSelectCard(null)} title="Close">
          ${icons.x}
        </button>
      </div>

      <div class="stack" style="margin-top: 14px;">
        <label class="field">
          <span>Title</span>
          <input
            .value=${card.title}
            @input=${(e: Event) => state.orchUpdateCard(card.id, { title: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="grid grid-cols-2" style="gap: 12px;">
          <label class="field">
            <span>Runner</span>
            <select
              .value=${card.runner ?? "subagent"}
              @change=${(e: Event) =>
                state.orchUpdateCard(card.id, {
                  runner: (e.target as HTMLSelectElement).value === "codex" ? "codex" : "subagent",
                })}
            >
              <option value="subagent">Sub-agent</option>
              <option value="codex">Codex CLI</option>
            </select>
          </label>

          <label class="field">
            <span>Lane</span>
            <select
              .value=${card.laneId}
              @change=${(e: Event) => state.orchMoveCard(card.id, (e.target as HTMLSelectElement).value as OrchestrationLaneId)}
            >
              ${laneOptions.map((lane) => html`<option value=${lane.id}>${lane.title}</option>`)}
            </select>
          </label>

          <label class="field">
            <span>${isCodex ? "Agent/Profile" : "Agent"}</span>
            <select
              .value=${card.agentId}
              @change=${(e: Event) =>
                state.orchUpdateCard(card.id, { agentId: (e.target as HTMLSelectElement).value })}
            >
              ${agents.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
            </select>
          </label>
        </div>

        <label class="field">
          <span>Task Prompt</span>
          <textarea
            .value=${card.task}
            rows="7"
            placeholder=${isCodex ? "Describe the exact code work Codex should do." : "Describe the exact work this sub-agent should do."}
            @input=${(e: Event) => state.orchUpdateCard(card.id, { task: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
        </label>

        <div class="filters">
          <button
            class="btn primary"
            type="button"
            ?disabled=${busy || !state.connected || !card.task.trim()}
            @click=${() => state.orchRunCard(card.id)}
            title=${state.connected ? (isCodex ? "Run task via Codex CLI" : "Spawn a sub-agent run") : "Connect to the gateway first"}
          >
            ${icons.zap}
            ${busy ? "Launching…" : running ? "Relaunch" : "Launch"}
          </button>
          <button class="btn" type="button" @click=${() => state.orchDuplicateCard(card.id)} title="Duplicate card">
            ${icons.copy}
            Duplicate
          </button>
          <button
            class="btn danger"
            type="button"
            ?disabled=${busy}
            @click=${() => state.orchDeleteCard(card.id)}
            title="Delete card"
          >
            ${icons.x}
            Delete
          </button>
        </div>

        <div class="orch-divider"></div>

        <div class="orch-side-title">Run Settings</div>
        <div class="orch-side-sub">Optional overrides applied to this card's next run.</div>

        <div class="stack" style="margin-top: 10px;">
          ${
            isCodex
              ? html`
                  <label class="field">
                    <span>Codex Mode</span>
                    <select
                      .value=${card.codexMode ?? "apply"}
                      @change=${(e: Event) =>
                        state.orchUpdateCard(card.id, {
                          codexMode: (e.target as HTMLSelectElement).value as CodexMode,
                        })}
                    >
                      ${CODEX_MODES.map((m) => html`<option value=${m}>${m}</option>`)}
                    </select>
                  </label>

                  <label class="field">
                    <span>Shell Allowlist (run mode)</span>
                    <textarea
                      .value=${(card.codexShellAllowlist ?? []).join("\n")}
                      placeholder="One command per line, e.g.\npnpm --dir core test"
                      rows="5"
                      @input=${(e: Event) => {
                        const raw = (e.target as HTMLTextAreaElement).value;
                        const list = raw
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean)
                          .slice(0, 200);
                        state.orchUpdateCard(card.id, { codexShellAllowlist: list });
                      }}
                    ></textarea>
                  </label>

                  <label class="field">
                    <span>Timeout (seconds)</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      .value=${timeoutValue}
                      placeholder="0"
                      @input=${(e: Event) => {
                        const raw = (e.target as HTMLInputElement).value;
                        const parsed = raw.trim() ? Number(raw) : NaN;
                        state.orchUpdateCard(card.id, {
                          timeoutSeconds: Number.isFinite(parsed)
                            ? Math.max(0, Math.floor(parsed))
                            : undefined,
                        });
                      }}
                    />
                  </label>

                  <div class="muted">
                    Worktrees are created under <span class="mono">.worktrees/</span> using this card id.
                  </div>
                `
              : html`
                  <label class="field">
                    <span>Model Override (optional)</span>
                    <input
                      .value=${card.model ?? ""}
                      placeholder="openai-codex/gpt-5.3-codex"
                      @input=${(e: Event) => state.orchUpdateCard(card.id, { model: (e.target as HTMLInputElement).value })}
                    />
                  </label>

                  <div class="grid grid-cols-2" style="gap: 12px;">
                    <label class="field">
                      <span>Thinking</span>
                      <select
                        .value=${card.thinking ?? ""}
                        @change=${(e: Event) =>
                          state.orchUpdateCard(card.id, {
                            thinking: (e.target as HTMLSelectElement).value,
                          })}
                      >
                        ${THINK_LEVELS.map(
                          (level) =>
                            html`<option value=${level}>${level ? level : "inherit"}</option>`,
                        )}
                      </select>
                    </label>

                    <label class="field">
                      <span>Timeout (seconds)</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        .value=${timeoutValue}
                        placeholder="0"
                        @input=${(e: Event) => {
                          const raw = (e.target as HTMLInputElement).value;
                          const parsed = raw.trim() ? Number(raw) : NaN;
                          state.orchUpdateCard(card.id, {
                            timeoutSeconds: Number.isFinite(parsed)
                              ? Math.max(0, Math.floor(parsed))
                              : undefined,
                          });
                        }}
                      />
                    </label>
                  </div>

                  <label class="field">
                    <span>Cleanup</span>
                    <select
                      .value=${card.cleanup ?? "keep"}
                      @change=${(e: Event) =>
                        state.orchUpdateCard(card.id, {
                          cleanup:
                            (e.target as HTMLSelectElement).value === "delete" ? "delete" : "keep",
                        })}
                    >
                      <option value="keep">Keep session</option>
                      <option value="delete">Delete session after completion</option>
                    </select>
                  </label>
                `
          }
        </div>

        <div class="orch-divider"></div>

        <div class="orch-side-title">Latest Run</div>
        <div class="orch-side-sub">${run ? "Telemetry from the most recent attempt." : "No runs yet."}</div>

        ${
          run
            ? html`
                <div class="stack" style="margin-top: 10px;">
                  <div class="filters">
                    <span class="pill ${run.status === "error" ? "danger" : ""}">
                      <span class="statusDot ${run.status === "done" || run.status === "running" ? "ok" : ""}"></span>
                      <span>${status}</span>
                    </span>
                    ${
                      run.provider || run.model
                        ? html`<span class="pill"><span class="mono">${run.provider ?? "?"}/${run.model ?? "?"}</span></span>`
                        : nothing
                    }
                  </div>

                  <div class="muted">
                    RunId: <span class="mono">${run.runId}</span>
                  </div>
                  <div class="muted">
                    Session: <span class="mono">${run.sessionKey}</span>
                  </div>

                  <div class="filters" style="margin-top: 6px;">
                    <button
                      class="btn btn--sm"
                      type="button"
                      ?disabled=${!hasSession}
                      @click=${() => hasSession && state.openChatSession(run.sessionKey)}
                      title=${
                        hasSession
                          ? "Open this run session in Chat"
                          : isCodex
                            ? "Codex CLI runs do not create chat sessions"
                            : "No session available"
                      }
                    >
                      ${icons.messageSquare}
                      Open Chat
                    </button>
                    <button
                      class="btn btn--sm"
                      type="button"
                      ?disabled=${cleanupDisabled}
                      @click=${() => state.orchCleanupCardSession(card.id)}
                      title=${
                        isCodex
                          ? "Cleanup is only supported for sub-agent transcripts"
                          : autoDelete
                            ? "Auto-delete is enabled, cleanup is handled by the sub-agent handoff flow"
                            : "Delete the sub-agent session transcript"
                      }
                    >
                      ${icons.trash ?? icons.x}
                      ${
                        autoDelete
                          ? "Auto-delete"
                          : cleanupStatus === "pending"
                            ? "Cleaning…"
                            : "Cleanup"
                      }
                    </button>
                  </div>

                  ${
                    run.warning
                      ? html`<div class="callout" style="margin-top: 10px;">
                        <div class="muted">Warning</div>
                        <div class="mono" style="margin-top: 6px; white-space: pre-wrap;">${run.warning}</div>
                      </div>`
                      : nothing
                  }
                  ${
                    run.error
                      ? html`<div class="callout danger" style="margin-top: 10px;">
                        <div class="muted">Error</div>
                        <div class="mono" style="margin-top: 6px; white-space: pre-wrap;">${run.error}</div>
                      </div>`
                      : nothing
                  }

                  <div class="orch-output">${lastText || "No streamed output yet."}</div>
                </div>
              `
            : html`
                <div class="muted" style="margin-top: 12px">Launch a run to see lifecycle + output here.</div>
              `
        }
      </div>
    </section>
  `;
}

export function renderOrchestrator(state: AppViewState) {
  const s = state as OrchestratorHost;
  const board = resolveBoard(s);
  if (!board) {
    return html`
      <section class="card">
        <div class="card-title">Orchestrator</div>
        <div class="card-sub">No boards found in local storage.</div>
      </section>
    `;
  }

  const selectedCard = resolveSelectedCard(board, s.orchSelectedCardId);

  return html`
    <section class="orch-layout">
      <section class="orch-board">
        <div class="orch-board-header">
          <div>
            <div class="orch-board-title">${board.title}</div>
            <div class="orch-board-sub">
              Drag cards between lanes, then launch sub-agents or Codex CLI runs to execute the prompts.
            </div>
          </div>
          <div class="filters" style="justify-content: flex-end;">
            <span class="pill">
              <span class="statusDot ${s.connected ? "ok" : ""}"></span>
              <span>${s.connected ? "Gateway connected" : "Offline"}</span>
            </span>
            <button class="btn btn--sm" type="button" @click=${() => s.orchCreateCard("backlog")}>
              ${icons.penLine}
              New task
            </button>
          </div>
        </div>

        <div class="orch-columns">
          ${board.lanes.map((lane) => renderLane(s, board, lane))}
        </div>
      </section>

      <section class="orch-side">
        ${selectedCard ? renderInspector(s, board, selectedCard) : renderLaunchpad(s, board)}
      </section>
    </section>
  `;
}
