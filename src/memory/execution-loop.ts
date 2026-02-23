import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { hashText } from "./internal.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const COMMITMENT_STATUS_VALUES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export const OPEN_COMMITMENT_STATUSES = ["open", "in_progress", "blocked"] as const;

export type CommitmentStatus = (typeof COMMITMENT_STATUS_VALUES)[number];

export type CommitmentUrgency = "overdue" | "due_soon";

const COMMITMENT_STATUS_SET = new Set<string>(COMMITMENT_STATUS_VALUES);

const CommitmentStatusSchema = z.enum(COMMITMENT_STATUS_VALUES);

const CommitmentProvenanceSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  extractedAt: z.string().regex(ISO_DATETIME_RE),
  sourceHash: z.string().min(8),
});

const TrackedCommitmentSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1),
  title: z.string().min(1),
  owner: z.string().min(1),
  dueDate: z.string().regex(ISO_DATE_RE).optional(),
  status: CommitmentStatusSchema,
  createdAt: z.string().regex(ISO_DATETIME_RE),
  updatedAt: z.string().regex(ISO_DATETIME_RE),
  closedAt: z.string().regex(ISO_DATETIME_RE).optional(),
  closureNote: z.string().min(1).optional(),
  provenance: z.array(CommitmentProvenanceSchema),
});

const TrackedCommitmentStoreSchema = z.object({
  version: z.literal(1),
  commitments: z.array(TrackedCommitmentSchema),
});

const ExtractedCommitmentSchema = z.object({
  title: z.string().min(1),
  owner: z.string().min(1),
  dueDate: z.string().regex(ISO_DATE_RE).optional(),
  status: CommitmentStatusSchema,
  dedupeKey: z.string().min(1),
  provenance: CommitmentProvenanceSchema,
});

export type TrackedCommitment = z.infer<typeof TrackedCommitmentSchema>;
export type TrackedCommitmentStore = z.infer<typeof TrackedCommitmentStoreSchema>;
export type CommitmentProvenance = z.infer<typeof CommitmentProvenanceSchema>;
export type ExtractedCommitment = z.infer<typeof ExtractedCommitmentSchema>;

export type DecisionRecordInput = {
  path: string;
  content: string;
};

export type IngestCommitmentsSummary = {
  extracted: number;
  created: number;
  updated: number;
  duplicates: number;
};

export type ListTrackedCommitmentsParams = {
  statuses?: CommitmentStatus[];
  owner?: string;
  dueBefore?: string;
  dueAfter?: string;
  includeClosed?: boolean;
  limit?: number;
};

export type UpdateTrackedCommitmentParams = {
  id: string;
  status?: CommitmentStatus;
  owner?: string;
  dueDate?: string | null;
  title?: string;
  closureNote?: string;
  nowIso?: string;
};

export type CloseTrackedCommitmentParams = {
  id: string;
  closureNote?: string;
  nowIso?: string;
};

export type ReminderCheckParams = {
  nowIso?: string;
  windowHours?: number;
  owner?: string;
};

export type ReminderEntry = {
  id: string;
  title: string;
  owner: string;
  status: CommitmentStatus;
  dueDate: string;
  urgency: CommitmentUrgency;
  dueInHours: number;
};

export type ReminderDigest = {
  generatedAt: string;
  windowHours: number;
  totalOpenWithDueDate: number;
  overdueCount: number;
  dueSoonCount: number;
  items: ReminderEntry[];
};

export type ReminderRenderMode = "plain" | "cron" | "heartbeat";

const TRANSITIONS: Record<CommitmentStatus, CommitmentStatus[]> = {
  open: ["open", "in_progress", "blocked", "done", "cancelled"],
  in_progress: ["in_progress", "open", "blocked", "done", "cancelled"],
  blocked: ["blocked", "in_progress", "open", "done", "cancelled"],
  done: ["done", "open"],
  cancelled: ["cancelled", "open"],
};

function isOpenCommitmentStatus(
  status: CommitmentStatus,
): status is (typeof OPEN_COMMITMENT_STATUSES)[number] {
  return status === "open" || status === "in_progress" || status === "blocked";
}

// transition map above intentionally enumerates allowed status edges.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(input?: string): string {
  if (!input) {
    return new Date().toISOString();
  }
  const trimmed = input.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO datetime: ${input}`);
  }
  return new Date(parsed).toISOString();
}

export function parseCommitmentStatus(raw?: string): CommitmentStatus | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (COMMITMENT_STATUS_SET.has(normalized)) {
    return normalized as CommitmentStatus;
  }
  if (normalized === "todo" || normalized === "pending") {
    return "open";
  }
  if (normalized === "wip" || normalized === "inprogress") {
    return "in_progress";
  }
  if (normalized === "closed" || normalized === "complete" || normalized === "completed") {
    return "done";
  }
  if (normalized === "canceled") {
    return "cancelled";
  }
  return undefined;
}

export function normalizeCommitmentOwner(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "unassigned";
  }
  return trimmed.replace(/^@+/, "").toLowerCase();
}

function normalizeCommitmentTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function normalizeIsoDate(raw?: string): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const candidate = raw.trim().replace(/\//g, "-");
  if (!ISO_DATE_RE.test(candidate)) {
    return undefined;
  }
  const parsed = Date.parse(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const normalized = new Date(parsed).toISOString().slice(0, 10);
  if (normalized !== candidate) {
    return undefined;
  }
  return normalized;
}

function parseOwnerFromText(raw: string): string | undefined {
  const kv = raw.match(/\bowner\s*[:=]\s*([^|;,\n]+)/i)?.[1];
  if (kv) {
    return normalizeCommitmentOwner(kv);
  }
  const mention = raw.match(/@([a-z0-9._-]+)/i)?.[1];
  if (mention) {
    return normalizeCommitmentOwner(mention);
  }
  return undefined;
}

function parseDueDateFromText(raw: string): string | undefined {
  const kv = raw.match(/\bdue\s*[:=]\s*(\d{4}[-/]\d{2}[-/]\d{2})/i)?.[1];
  if (kv) {
    return normalizeIsoDate(kv);
  }
  const by = raw.match(/\bby\s+(\d{4}[-/]\d{2}[-/]\d{2})/i)?.[1];
  if (by) {
    return normalizeIsoDate(by);
  }
  return undefined;
}

function parseInlineDecisionPayload(raw: string): {
  title: string;
  owner?: string;
  dueDate?: string;
  status?: CommitmentStatus;
} {
  const status = parseCommitmentStatus(raw.match(/\bstatus\s*[:=]\s*([^|;,\n]+)/i)?.[1]);
  const owner = parseOwnerFromText(raw);
  const dueDate = parseDueDateFromText(raw);
  const titleSeed = raw
    .replace(/^(decision|action|commitment)\s*:\s*/i, "")
    .replace(/\b(owner|due|status)\s*[:=]\s*[^|;,\n]+/gi, " ")
    .replace(/@[a-z0-9._-]+/gi, " ")
    .replace(/\s*[|;]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = normalizeCommitmentTitle(titleSeed || raw);
  return { title, owner, dueDate, status };
}

function parseMetadataLine(
  raw: string,
): { kind: "owner" | "due" | "status" | "title"; value: string } | null {
  const match = raw.trim().match(/^(?:[-*]\s*)?(owner|due|status|title|action)\s*[:=]\s*(.+)$/i);
  if (!match) {
    return null;
  }
  const keyRaw = (match[1] ?? "").toLowerCase();
  const key = keyRaw === "action" ? "title" : keyRaw;
  if (key !== "owner" && key !== "due" && key !== "status" && key !== "title") {
    return null;
  }
  return { kind: key, value: (match[2] ?? "").trim() };
}

function toDedupeKey(params: { title: string; owner: string; dueDate?: string }): string {
  return [
    normalizeCommitmentTitle(params.title).toLowerCase(),
    normalizeCommitmentOwner(params.owner),
    params.dueDate ?? "none",
  ].join("|");
}

function toCommitmentId(dedupeKey: string): string {
  return `cmt_${hashText(dedupeKey).slice(0, 16)}`;
}

function normalizeProvenancePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  return trimmed.replace(/\\/g, "/");
}

function createExtractedCommitment(params: {
  title: string;
  owner?: string;
  dueDate?: string;
  status?: CommitmentStatus;
  path: string;
  startLine: number;
  endLine: number;
  extractedAt: string;
  sourceText: string;
}): ExtractedCommitment | null {
  const title = normalizeCommitmentTitle(params.title);
  if (!title) {
    return null;
  }
  const owner = normalizeCommitmentOwner(params.owner);
  const dueDate = normalizeIsoDate(params.dueDate);
  const status = params.status ?? "open";
  const dedupeKey = toDedupeKey({ title, owner, dueDate });
  const sourceHash = hashText(
    `${normalizeProvenancePath(params.path)}:${params.startLine}:${params.endLine}:${params.sourceText.trim()}`,
  );
  const parsed = ExtractedCommitmentSchema.safeParse({
    title,
    owner,
    dueDate,
    status,
    dedupeKey,
    provenance: {
      path: normalizeProvenancePath(params.path),
      startLine: params.startLine,
      endLine: params.endLine,
      extractedAt: params.extractedAt,
      sourceHash,
    },
  });
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function extractDecisionCommitmentsFromMarkdown(params: {
  path: string;
  content: string;
  extractedAt?: string;
}): ExtractedCommitment[] {
  const sourcePath = normalizeProvenancePath(params.path);
  const extractedAt = nowIso(params.extractedAt);
  const lines = params.content.split(/\r?\n/);
  const extracted: ExtractedCommitment[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineRaw = lines[i] ?? "";
    const line = lineRaw.trim();
    if (!line) {
      continue;
    }

    const decisionMatch = line.match(
      /^(?:#{1,6}\s+|[-*]\s+)?(decision|action|commitment)\s*:\s*(.+)$/i,
    );
    if (decisionMatch) {
      let title = (decisionMatch[2] ?? "").trim();
      let owner = parseOwnerFromText(title);
      let dueDate = parseDueDateFromText(title);
      let status = parseCommitmentStatus(title.match(/\bstatus\s*[:=]\s*([^|;,\n]+)/i)?.[1]);
      title = parseInlineDecisionPayload(title).title;

      let endLine = i + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidateRaw = lines[j] ?? "";
        const candidate = candidateRaw.trim();
        if (!candidate) {
          if (endLine > i + 1) {
            continue;
          }
          break;
        }
        if (/^(?:#{1,6}\s+|[-*]\s+)?(decision|action|commitment)\s*:/i.test(candidate)) {
          break;
        }
        if (/^[-*]\s*\[(?: |x|X)\]\s+/.test(candidate)) {
          break;
        }
        if (/^#{1,6}\s+/.test(candidate)) {
          break;
        }
        const metadata = parseMetadataLine(candidate);
        if (!metadata) {
          break;
        }
        if (metadata.kind === "title") {
          title = normalizeCommitmentTitle(metadata.value);
        }
        if (metadata.kind === "owner") {
          owner = normalizeCommitmentOwner(metadata.value);
        }
        if (metadata.kind === "due") {
          dueDate = normalizeIsoDate(metadata.value);
        }
        if (metadata.kind === "status") {
          status = parseCommitmentStatus(metadata.value) ?? status;
        }
        endLine = j + 1;
      }

      const item = createExtractedCommitment({
        title,
        owner,
        dueDate,
        status,
        path: sourcePath,
        startLine: i + 1,
        endLine,
        extractedAt,
        sourceText: lines.slice(i, endLine).join("\n"),
      });
      if (item) {
        extracted.push(item);
      }
      continue;
    }

    const checkboxMatch = line.match(/^[-*]\s*\[( |x|X)\]\s+(.+)$/);
    if (checkboxMatch) {
      const payload = (checkboxMatch[2] ?? "").trim();
      const looksDecision = /\b(decision|action|commitment)\b/i.test(payload);
      const dueDate = parseDueDateFromText(payload);
      if (!looksDecision && !dueDate) {
        continue;
      }
      const parsedPayload = parseInlineDecisionPayload(payload);
      const fallbackTitle = payload
        .replace(/\b(?:decision|action|commitment)\s*:\s*/i, "")
        .replace(/\bdue\s*[:=]\s*\d{4}[-/]\d{2}[-/]\d{2}/gi, "")
        .replace(/\bstatus\s*[:=]\s*[^|;,\n]+/gi, "")
        .replace(/@([a-z0-9._-]+)/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const item = createExtractedCommitment({
        title: parsedPayload.title || fallbackTitle,
        owner: parsedPayload.owner,
        dueDate: parsedPayload.dueDate ?? dueDate,
        status: checkboxMatch[1] === "x" || checkboxMatch[1] === "X" ? "done" : "open",
        path: sourcePath,
        startLine: i + 1,
        endLine: i + 1,
        extractedAt,
        sourceText: lineRaw,
      });
      if (item) {
        extracted.push(item);
      }
    }
  }

  const seen = new Set<string>();
  const deduped: ExtractedCommitment[] = [];
  for (const item of extracted) {
    const key = `${item.dedupeKey}|${item.provenance.sourceHash}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  deduped.sort((a, b) => {
    if (a.provenance.path !== b.provenance.path) {
      return a.provenance.path.localeCompare(b.provenance.path);
    }
    return a.provenance.startLine - b.provenance.startLine;
  });
  return deduped;
}

export function extractDecisionCommitmentsFromRecords(params: {
  records: DecisionRecordInput[];
  extractedAt?: string;
}): ExtractedCommitment[] {
  const out: ExtractedCommitment[] = [];
  for (const record of params.records) {
    out.push(
      ...extractDecisionCommitmentsFromMarkdown({
        path: record.path,
        content: record.content,
        extractedAt: params.extractedAt,
      }),
    );
  }
  out.sort((a, b) => {
    if (a.provenance.path !== b.provenance.path) {
      return a.provenance.path.localeCompare(b.provenance.path);
    }
    if (a.provenance.startLine !== b.provenance.startLine) {
      return a.provenance.startLine - b.provenance.startLine;
    }
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });
  return out;
}

function sortProvenance(a: CommitmentProvenance, b: CommitmentProvenance): number {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  if (a.startLine !== b.startLine) {
    return a.startLine - b.startLine;
  }
  if (a.endLine !== b.endLine) {
    return a.endLine - b.endLine;
  }
  return a.sourceHash.localeCompare(b.sourceHash);
}

function sortCommitments(a: TrackedCommitment, b: TrackedCommitment): number {
  const closedRank = OPEN_COMMITMENT_STATUSES.includes(
    a.status as (typeof OPEN_COMMITMENT_STATUSES)[number],
  )
    ? 0
    : 1;
  const otherClosedRank = OPEN_COMMITMENT_STATUSES.includes(
    b.status as (typeof OPEN_COMMITMENT_STATUSES)[number],
  )
    ? 0
    : 1;
  if (closedRank !== otherClosedRank) {
    return closedRank - otherClosedRank;
  }
  if ((a.dueDate ?? "") !== (b.dueDate ?? "")) {
    if (!a.dueDate) {
      return 1;
    }
    if (!b.dueDate) {
      return -1;
    }
    return a.dueDate.localeCompare(b.dueDate);
  }
  if (a.owner !== b.owner) {
    return a.owner.localeCompare(b.owner);
  }
  if (a.title !== b.title) {
    return a.title.localeCompare(b.title);
  }
  return a.id.localeCompare(b.id);
}

export function emptyTrackedCommitmentStore(): TrackedCommitmentStore {
  return { version: 1, commitments: [] };
}

export function ingestExtractedCommitments(params: {
  store: TrackedCommitmentStore;
  extracted: ExtractedCommitment[];
  nowIso?: string;
}): IngestCommitmentsSummary {
  const now = nowIso(params.nowIso);
  const summary: IngestCommitmentsSummary = {
    extracted: params.extracted.length,
    created: 0,
    updated: 0,
    duplicates: 0,
  };

  const byDedupe = new Map<string, TrackedCommitment>();
  for (const commitment of params.store.commitments) {
    byDedupe.set(commitment.dedupeKey, commitment);
  }

  for (const item of params.extracted) {
    const existing = byDedupe.get(item.dedupeKey);
    if (!existing) {
      const created: TrackedCommitment = {
        id: toCommitmentId(item.dedupeKey),
        dedupeKey: item.dedupeKey,
        title: item.title,
        owner: item.owner,
        dueDate: item.dueDate,
        status: item.status,
        createdAt: now,
        updatedAt: now,
        closedAt: item.status === "done" || item.status === "cancelled" ? now : undefined,
        provenance: [item.provenance],
      };
      params.store.commitments.push(created);
      byDedupe.set(created.dedupeKey, created);
      summary.created += 1;
      continue;
    }

    const hasSource = existing.provenance.some(
      (entry) => entry.sourceHash === item.provenance.sourceHash,
    );
    let changed = false;
    if (!hasSource) {
      existing.provenance.push(item.provenance);
      existing.provenance.sort(sortProvenance);
      changed = true;
    } else {
      summary.duplicates += 1;
    }

    if (existing.owner === "unassigned" && item.owner !== "unassigned") {
      existing.owner = item.owner;
      changed = true;
    }
    if (!existing.dueDate && item.dueDate) {
      existing.dueDate = item.dueDate;
      changed = true;
    }
    if (existing.status === "open" && item.status !== "open") {
      existing.status = item.status;
      if (item.status === "done" || item.status === "cancelled") {
        existing.closedAt = now;
      }
      changed = true;
    }
    if (changed) {
      existing.updatedAt = now;
      summary.updated += 1;
    }
  }

  params.store.commitments.sort(sortCommitments);
  return summary;
}

function assertTransition(from: CommitmentStatus, to: CommitmentStatus): void {
  const allowed = TRANSITIONS[from] ?? [from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid commitment status transition: ${from} -> ${to}`);
  }
}

export function updateTrackedCommitment(params: {
  store: TrackedCommitmentStore;
  update: UpdateTrackedCommitmentParams;
}): TrackedCommitment {
  const nextAt = nowIso(params.update.nowIso);
  const target = params.store.commitments.find((entry) => entry.id === params.update.id);
  if (!target) {
    throw new Error(`Commitment not found: ${params.update.id}`);
  }

  let changed = false;

  const ensureUniqueDedupe = (nextKey: string): void => {
    const collision = params.store.commitments.find(
      (entry) => entry.id !== target.id && entry.dedupeKey === nextKey,
    );
    if (collision) {
      throw new Error(`Commitment already exists for dedupe key: ${nextKey}`);
    }
  };

  if (params.update.title !== undefined) {
    const title = normalizeCommitmentTitle(params.update.title);
    if (!title) {
      throw new Error("title cannot be empty");
    }
    if (target.title !== title) {
      const nextKey = toDedupeKey({ title, owner: target.owner, dueDate: target.dueDate });
      ensureUniqueDedupe(nextKey);
      target.title = title;
      target.dedupeKey = nextKey;
      changed = true;
    }
  }

  if (params.update.owner !== undefined) {
    const owner = normalizeCommitmentOwner(params.update.owner);
    if (target.owner !== owner) {
      const nextKey = toDedupeKey({
        title: target.title,
        owner,
        dueDate: target.dueDate,
      });
      ensureUniqueDedupe(nextKey);
      target.owner = owner;
      target.dedupeKey = nextKey;
      changed = true;
    }
  }

  if (params.update.dueDate !== undefined) {
    const nextDue =
      params.update.dueDate === null ? undefined : normalizeIsoDate(params.update.dueDate);
    if (params.update.dueDate !== null && params.update.dueDate && !nextDue) {
      throw new Error(`Invalid due date: ${params.update.dueDate}`);
    }
    if (target.dueDate !== nextDue) {
      const nextKey = toDedupeKey({
        title: target.title,
        owner: target.owner,
        dueDate: nextDue,
      });
      ensureUniqueDedupe(nextKey);
      target.dueDate = nextDue;
      target.dedupeKey = nextKey;
      changed = true;
    }
  }

  if (params.update.status !== undefined && params.update.status !== target.status) {
    assertTransition(target.status, params.update.status);
    target.status = params.update.status;
    if (params.update.status === "done" || params.update.status === "cancelled") {
      target.closedAt = nextAt;
      target.closureNote = params.update.closureNote?.trim() || target.closureNote;
    } else {
      target.closedAt = undefined;
      target.closureNote = undefined;
    }
    changed = true;
  }

  if (params.update.closureNote !== undefined && params.update.status === undefined) {
    const note = params.update.closureNote.trim();
    target.closureNote = note || undefined;
    changed = true;
  }

  if (changed) {
    target.updatedAt = nextAt;
    params.store.commitments.sort(sortCommitments);
  }

  return target;
}

export function closeTrackedCommitment(params: {
  store: TrackedCommitmentStore;
  close: CloseTrackedCommitmentParams;
}): TrackedCommitment {
  return updateTrackedCommitment({
    store: params.store,
    update: {
      id: params.close.id,
      status: "done",
      closureNote: params.close.closureNote,
      nowIso: params.close.nowIso,
    },
  });
}

export function listTrackedCommitments(params: {
  store: TrackedCommitmentStore;
  filter?: ListTrackedCommitmentsParams;
}): TrackedCommitment[] {
  const filter = params.filter ?? {};
  const owner = filter.owner ? normalizeCommitmentOwner(filter.owner) : undefined;
  const statuses = filter.statuses?.length ? new Set(filter.statuses) : undefined;
  const dueBefore = normalizeIsoDate(filter.dueBefore);
  const dueAfter = normalizeIsoDate(filter.dueAfter);
  const includeClosed = filter.includeClosed ?? false;

  const items = params.store.commitments.filter((entry) => {
    if (!includeClosed && !isOpenCommitmentStatus(entry.status)) {
      return false;
    }
    if (statuses && !statuses.has(entry.status)) {
      return false;
    }
    if (owner && entry.owner !== owner) {
      return false;
    }
    if (dueBefore && (!entry.dueDate || entry.dueDate > dueBefore)) {
      return false;
    }
    if (dueAfter && (!entry.dueDate || entry.dueDate < dueAfter)) {
      return false;
    }
    return true;
  });

  items.sort(sortCommitments);
  if (typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit >= 0) {
    return items.slice(0, filter.limit);
  }
  return items;
}

function dueDateToEndOfDayMs(dueDate: string): number {
  return Date.parse(`${dueDate}T23:59:59.999Z`);
}

export function buildReminderDigest(params: {
  store: TrackedCommitmentStore;
  check?: ReminderCheckParams;
}): ReminderDigest {
  const check = params.check ?? {};
  const generatedAt = nowIso(check.nowIso);
  const nowMs = Date.parse(generatedAt);
  const windowHours =
    typeof check.windowHours === "number" && Number.isFinite(check.windowHours)
      ? Math.max(1, Math.floor(check.windowHours))
      : 48;
  const owner = check.owner ? normalizeCommitmentOwner(check.owner) : undefined;

  const openItems = params.store.commitments.filter((entry) => {
    if (!isOpenCommitmentStatus(entry.status)) {
      return false;
    }
    if (!entry.dueDate) {
      return false;
    }
    if (owner && entry.owner !== owner) {
      return false;
    }
    return true;
  });

  const reminders: ReminderEntry[] = [];
  for (const entry of openItems) {
    const dueAtMs = dueDateToEndOfDayMs(entry.dueDate ?? "");
    if (!Number.isFinite(dueAtMs)) {
      continue;
    }
    const dueInHours = (dueAtMs - nowMs) / (60 * 60 * 1000);
    const urgency: CommitmentUrgency | null =
      dueInHours < 0 ? "overdue" : dueInHours <= windowHours ? "due_soon" : null;
    if (!urgency) {
      continue;
    }
    reminders.push({
      id: entry.id,
      title: entry.title,
      owner: entry.owner,
      status: entry.status,
      dueDate: entry.dueDate ?? "",
      urgency,
      dueInHours,
    });
  }

  reminders.sort((a, b) => {
    if (a.dueDate !== b.dueDate) {
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (a.urgency !== b.urgency) {
      return a.urgency === "overdue" ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  const overdueCount = reminders.filter((entry) => entry.urgency === "overdue").length;
  const dueSoonCount = reminders.filter((entry) => entry.urgency === "due_soon").length;

  return {
    generatedAt,
    windowHours,
    totalOpenWithDueDate: openItems.length,
    overdueCount,
    dueSoonCount,
    items: reminders,
  };
}

export function renderReminderDigest(params: {
  digest: ReminderDigest;
  mode?: ReminderRenderMode;
}): string {
  const mode = params.mode ?? "plain";
  const { digest } = params;
  if (digest.items.length === 0) {
    if (mode === "heartbeat") {
      return "HEARTBEAT_OK";
    }
    return "No due commitments.";
  }

  const lines: string[] = [];
  lines.push(
    `Commitment reminders: ${digest.items.length} item(s) (overdue ${digest.overdueCount}, due soon ${digest.dueSoonCount})`,
  );
  for (const item of digest.items) {
    const tag = item.urgency === "overdue" ? "OVERDUE" : "DUE_SOON";
    lines.push(
      `- [${tag}] ${item.title} (owner: ${item.owner}, due: ${item.dueDate}, status: ${item.status}, id: ${item.id})`,
    );
  }
  return lines.join("\n");
}

export function resolveTrackedCommitmentStorePath(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return path.join(agentDir, "memory", "commitments.v1.json");
}

function normalizeStoreForSave(store: TrackedCommitmentStore): TrackedCommitmentStore {
  const byId = new Map<string, TrackedCommitment>();
  for (const item of store.commitments) {
    const current = byId.get(item.id);
    if (!current || current.updatedAt < item.updatedAt) {
      byId.set(item.id, {
        ...item,
        provenance: item.provenance.toSorted(sortProvenance),
      });
    }
  }
  const commitments = Array.from(byId.values());
  commitments.sort(sortCommitments);
  return { version: 1, commitments };
}

export async function loadTrackedCommitmentStore(
  storePath: string,
): Promise<TrackedCommitmentStore> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsedUnknown = JSON.parse(raw) as unknown;
    const parsed = TrackedCommitmentStoreSchema.safeParse(parsedUnknown);
    if (!parsed.success) {
      throw new Error(`Invalid tracked commitment store at ${storePath}`);
    }
    return normalizeStoreForSave(parsed.data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyTrackedCommitmentStore();
    }
    throw err;
  }
}

export async function saveTrackedCommitmentStore(params: {
  storePath: string;
  store: TrackedCommitmentStore;
}): Promise<void> {
  const normalized = normalizeStoreForSave(params.store);
  const parsed = TrackedCommitmentStoreSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Refusing to save invalid tracked commitment store at ${params.storePath}`);
  }

  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  const tmp = `${params.storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const payload = JSON.stringify(parsed.data, null, 2);
  await fs.writeFile(tmp, payload, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, params.storePath);
  try {
    await fs.chmod(params.storePath, 0o600);
  } catch {
    // best-effort
  }
}

async function withCommitmentStoreLock<T>(params: {
  storePath: string;
  fn: () => Promise<T>;
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30_000;
  const pollMs = params.pollMs ?? 25;
  const lockPath = `${params.storePath}.lock`;
  const startedAt = Date.now();

  await fs.mkdir(path.dirname(params.storePath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
      await handle.close();
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // best-effort
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for tracked commitment store lock: ${lockPath}`, {
          cause: err,
        });
      }
      await sleep(pollMs);
    }
  }

  try {
    return await params.fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

export async function updateTrackedCommitmentStore<T>(params: {
  storePath: string;
  mutator: (store: TrackedCommitmentStore) => Promise<T> | T;
}): Promise<T> {
  return await withCommitmentStoreLock({
    storePath: params.storePath,
    fn: async () => {
      const store = await loadTrackedCommitmentStore(params.storePath);
      const result = await params.mutator(store);
      await saveTrackedCommitmentStore({ storePath: params.storePath, store });
      return result;
    },
  });
}
