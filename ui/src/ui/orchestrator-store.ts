import { generateUUID } from "./uuid.ts";

const STORAGE_KEY = "openclaw.control.orchestrator.v1";

export type OrchestrationLaneId =
  | "backlog"
  | "running"
  | "review"
  | "done"
  | "failed"
  | (string & {});

export type OrchestrationLane = {
  id: OrchestrationLaneId;
  title: string;
  description?: string;
};

export type OrchestrationRunStatus = "idle" | "accepted" | "running" | "done" | "error";

export type OrchestrationRunner = "subagent" | "codex";
export type CodexMode = "plan" | "apply" | "run";

export type OrchestrationCardRun = {
  runId: string;
  sessionKey: string;
  status: OrchestrationRunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  warning?: string;
  provider?: string;
  model?: string;
  thinkLevel?: string;
  lastText?: string;
  cleanup?: {
    mode: "keep" | "delete";
    status?: "pending" | "done" | "error";
    error?: string;
  };
};

export type OrchestrationCard = {
  id: string;
  laneId: OrchestrationLaneId;
  runner?: OrchestrationRunner;
  title: string;
  task: string;
  agentId: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  cleanup?: "keep" | "delete";
  tags?: string[];
  // Codex runner settings (when runner === "codex")
  codexMode?: CodexMode;
  codexShellAllowlist?: string[];
  run?: OrchestrationCardRun;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationBoard = {
  id: string;
  title: string;
  lanes: OrchestrationLane[];
  cards: OrchestrationCard[];
  createdAt: number;
  updatedAt: number;
};

export type OrchestratorState = {
  version: 1;
  selectedBoardId: string;
  boards: OrchestrationBoard[];
};

export const DEFAULT_LANES: OrchestrationLane[] = [
  { id: "backlog", title: "Backlog", description: "Queued work and ideas." },
  { id: "running", title: "Running", description: "Active sub-agent runs." },
  { id: "review", title: "Review", description: "Inspect results, promote, or retry." },
  { id: "done", title: "Done", description: "Accepted outcomes." },
  { id: "failed", title: "Failed", description: "Needs edits or reruns." },
];

export function createDefaultBoard(now = Date.now()): OrchestrationBoard {
  return {
    id: "main",
    title: "Mission Control",
    lanes: DEFAULT_LANES.map((lane) => ({ ...lane })),
    cards: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultOrchestratorState(now = Date.now()): OrchestratorState {
  const board = createDefaultBoard(now);
  return {
    version: 1,
    selectedBoardId: board.id,
    boards: [board],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLaneId(value: unknown): OrchestrationLaneId {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || "backlog") as OrchestrationLaneId;
}

function normalizeCleanupMode(value: unknown): "keep" | "delete" {
  return value === "delete" ? "delete" : "keep";
}

function normalizeRunner(value: unknown): OrchestrationRunner {
  return value === "codex" ? "codex" : "subagent";
}

function normalizeCodexMode(value: unknown): CodexMode | undefined {
  if (value === "plan" || value === "apply" || value === "run") {
    return value;
  }
  return undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
  return tags.length ? tags : undefined;
}

function normalizeRun(value: unknown): OrchestrationCardRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = readString(value.runId).trim();
  const sessionKey = readString(value.sessionKey).trim();
  if (!runId || !sessionKey) {
    return undefined;
  }
  const statusRaw = readString(value.status, "idle");
  const status =
    statusRaw === "accepted" ||
    statusRaw === "running" ||
    statusRaw === "done" ||
    statusRaw === "error"
      ? statusRaw
      : "idle";
  const createdAt = readNumber(value.createdAt) ?? Date.now();
  const cleanup = isRecord(value.cleanup)
    ? {
        mode: normalizeCleanupMode(value.cleanup.mode),
        status:
          value.cleanup.status === "pending" ||
          value.cleanup.status === "done" ||
          value.cleanup.status === "error"
            ? value.cleanup.status
            : undefined,
        error: typeof value.cleanup.error === "string" ? value.cleanup.error : undefined,
      }
    : undefined;
  return {
    runId,
    sessionKey,
    status,
    createdAt,
    startedAt: readNumber(value.startedAt),
    endedAt: readNumber(value.endedAt),
    error: typeof value.error === "string" ? value.error : undefined,
    warning: typeof value.warning === "string" ? value.warning : undefined,
    provider: typeof value.provider === "string" ? value.provider : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    thinkLevel: typeof value.thinkLevel === "string" ? value.thinkLevel : undefined,
    lastText: typeof value.lastText === "string" ? value.lastText : undefined,
    cleanup,
  };
}

function normalizeCard(value: unknown): OrchestrationCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id).trim() || generateUUID();
  const laneId = normalizeLaneId(value.laneId);
  const title = readString(value.title, "Untitled").trim() || "Untitled";
  const task = readString(value.task).trim();
  const agentId = readString(value.agentId, "main").trim() || "main";
  const runner = normalizeRunner(value.runner);
  const codexMode = normalizeCodexMode(value.codexMode);
  const codexShellAllowlist =
    Array.isArray(value.codexShellAllowlist) && value.codexShellAllowlist.length
      ? value.codexShellAllowlist
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean)
          .slice(0, 200)
      : undefined;
  const createdAt = readNumber(value.createdAt) ?? Date.now();
  const updatedAt = readNumber(value.updatedAt) ?? createdAt;
  return {
    id,
    laneId,
    runner,
    title,
    task,
    agentId,
    model: typeof value.model === "string" ? value.model : undefined,
    thinking: typeof value.thinking === "string" ? value.thinking : undefined,
    timeoutSeconds: readNumber(value.timeoutSeconds),
    cleanup: value.cleanup === "delete" || value.cleanup === "keep" ? value.cleanup : undefined,
    tags: normalizeTags(value.tags),
    codexMode,
    codexShellAllowlist,
    run: normalizeRun(value.run),
    createdAt,
    updatedAt,
  };
}

function normalizeBoard(value: unknown): OrchestrationBoard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id).trim() || "main";
  const title = readString(value.title, "Mission Control").trim() || "Mission Control";
  const now = Date.now();
  const createdAt = readNumber(value.createdAt) ?? now;
  const updatedAt = readNumber(value.updatedAt) ?? createdAt;

  const lanes =
    Array.isArray(value.lanes) && value.lanes.length
      ? value.lanes
          .map((lane) => {
            if (!isRecord(lane)) {
              return null;
            }
            const laneId = normalizeLaneId(lane.id);
            const laneTitle = readString(lane.title).trim() || String(laneId);
            const desc = typeof lane.description === "string" ? lane.description : undefined;
            return { id: laneId, title: laneTitle, description: desc } satisfies OrchestrationLane;
          })
          .filter((lane): lane is OrchestrationLane => Boolean(lane))
      : DEFAULT_LANES.map((lane) => ({ ...lane }));

  const seenLaneIds = new Set<string>();
  const uniqueLanes = lanes.filter((lane) => {
    const key = String(lane.id);
    if (seenLaneIds.has(key)) {
      return false;
    }
    seenLaneIds.add(key);
    return true;
  });
  const cards =
    Array.isArray(value.cards) && value.cards.length
      ? value.cards.map(normalizeCard).filter((card): card is OrchestrationCard => Boolean(card))
      : [];
  return { id, title, lanes: uniqueLanes, cards, createdAt, updatedAt };
}

export function loadOrchestratorState(): OrchestratorState {
  const defaults = createDefaultOrchestratorState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return defaults;
    }
    const boards =
      Array.isArray(parsed.boards) && parsed.boards.length
        ? parsed.boards
            .map(normalizeBoard)
            .filter((board): board is OrchestrationBoard => Boolean(board))
        : [];
    const usableBoards = boards.length ? boards : defaults.boards;
    const selectedRaw = readString(parsed.selectedBoardId, defaults.selectedBoardId).trim();
    const selectedBoardId = usableBoards.some((board) => board.id === selectedRaw)
      ? selectedRaw
      : usableBoards[0].id;
    return { version: 1, selectedBoardId, boards: usableBoards };
  } catch {
    return defaults;
  }
}

export function saveOrchestratorState(
  state: Pick<OrchestratorState, "selectedBoardId" | "boards">,
) {
  const next: OrchestratorState = {
    version: 1,
    selectedBoardId: state.selectedBoardId,
    boards: state.boards,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
