import { randomUUID } from "node:crypto";
import type {
  ExecApprovalDecision,
  SystemRunApprovalBinding,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";

export type ExecApprovalRequestPayload = {
  command: string;
  commandArgv?: string[];
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
  actionKind?: string | null;
  riskTags?: string[] | null;
  requiresOutbound?: boolean | null;
  requiresElevation?: boolean | null;
};

export type ExecApprovalRecord = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  resolvedBy?: string | null;
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
};

type ApprovalEntry = {
  record: ExecApprovalRecord;
  promise: Promise<ExecApprovalDecision | null>;
  settle: (decision: ExecApprovalDecision | null) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  consumedAllowOnce: boolean;
};

export class ExecApprovalManager {
  private approvals = new Map<string, ApprovalEntry>();

  create(
    request: ExecApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): ExecApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    return {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
  }

  register(record: ExecApprovalRecord, timeoutMs: number): Promise<ExecApprovalDecision | null> {
    if (this.approvals.has(record.id)) {
      throw new Error(`approval ${record.id} already registered`);
    }

    let settle!: (decision: ExecApprovalDecision | null) => void;
    const promise = new Promise<ExecApprovalDecision | null>((resolve) => {
      settle = resolve;
    });

    const entry: ApprovalEntry = {
      record,
      promise,
      settle,
      settled: false,
      timer: setTimeout(() => {
        const current = this.approvals.get(record.id);
        if (!current) {
          return;
        }
        if (!current.settled) {
          current.settled = true;
          current.record.resolvedAtMs = Date.now();
          current.record.resolvedBy = null;
          current.settle(null);
        }
        this.approvals.delete(record.id);
      }, timeoutMs),
      consumedAllowOnce: false,
    };

    this.approvals.set(record.id, entry);
    return promise;
  }

  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null {
    return this.approvals.get(recordId)?.promise ?? null;
  }

  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
    const entry = this.approvals.get(recordId);
    if (!entry || entry.settled) {
      return false;
    }
    entry.settled = true;
    entry.record.resolvedAtMs = Date.now();
    entry.record.decision = decision;
    entry.record.resolvedBy = resolvedBy ?? null;
    entry.settle(decision);
    return true;
  }

  expire(recordId: string, _reason?: string): boolean {
    const entry = this.approvals.get(recordId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    if (!entry.settled) {
      entry.settled = true;
      entry.record.resolvedAtMs = Date.now();
      entry.record.resolvedBy = null;
      entry.settle(null);
    }
    this.approvals.delete(recordId);
    return true;
  }

  consumeAllowOnce(recordId: string): boolean {
    const entry = this.approvals.get(recordId);
    if (!entry || entry.consumedAllowOnce || entry.record.decision !== "allow-once") {
      return false;
    }
    entry.consumedAllowOnce = true;
    clearTimeout(entry.timer);
    this.approvals.delete(recordId);
    return true;
  }

  getSnapshot(recordId: string): ExecApprovalRecord | null {
    return this.approvals.get(recordId)?.record ?? null;
  }

  async waitForDecision(
    record: ExecApprovalRecord,
    timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    return await this.register(record, timeoutMs);
  }
}
