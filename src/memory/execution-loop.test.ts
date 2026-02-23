import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReminderDigest,
  closeTrackedCommitment,
  emptyTrackedCommitmentStore,
  extractDecisionCommitmentsFromRecords,
  ingestExtractedCommitments,
  listTrackedCommitments,
  loadTrackedCommitmentStore,
  renderReminderDigest,
  saveTrackedCommitmentStore,
  updateTrackedCommitment,
  updateTrackedCommitmentStore,
} from "./execution-loop.js";

describe("memory execution loop extraction", () => {
  it("extracts decision-style commitments with deterministic fields", () => {
    const extracted = extractDecisionCommitmentsFromRecords({
      extractedAt: "2026-03-01T10:00:00.000Z",
      records: [
        {
          path: "memory/2026-03-01.md",
          content: [
            "## Decision: Ship Feature 5 | owner: Spencer | due: 2026-03-08 | status: in-progress",
            "",
            "### Commitment: Publish operator docs",
            "owner: Ops",
            "due: 2026-03-09",
            "status: open",
            "",
            "- [ ] Action: Follow up QA @qa due: 2026-03-07",
          ].join("\n"),
        },
      ],
    });

    expect(extracted).toHaveLength(3);
    expect(extracted.map((entry) => entry.title)).toEqual([
      "Ship Feature 5",
      "Publish operator docs",
      "Follow up QA",
    ]);
    expect(extracted.map((entry) => entry.owner)).toEqual(["spencer", "ops", "qa"]);
    expect(extracted.map((entry) => entry.dueDate)).toEqual([
      "2026-03-08",
      "2026-03-09",
      "2026-03-07",
    ]);
    expect(extracted.map((entry) => entry.status)).toEqual(["in_progress", "open", "open"]);
    expect(
      extracted.every((entry) => entry.provenance.extractedAt === "2026-03-01T10:00:00.000Z"),
    ).toBe(true);
  });
});

describe("memory execution loop ingest + duplicate suppression", () => {
  it("suppresses duplicate commitments by dedupe key and merges provenance", () => {
    const extracted = extractDecisionCommitmentsFromRecords({
      extractedAt: "2026-03-01T10:00:00.000Z",
      records: [
        {
          path: "memory/2026-03-01.md",
          content: "Decision: Launch memory loop | owner: Alex | due: 2026-03-10",
        },
        {
          path: "memory/2026-03-02.md",
          content: "Decision: Launch memory loop | owner: Alex | due: 2026-03-10",
        },
        {
          path: "memory/2026-03-02.md",
          content: "Decision: Launch memory loop | owner: Alex | due: 2026-03-10",
        },
      ],
    });

    const store = emptyTrackedCommitmentStore();
    const summary = ingestExtractedCommitments({
      store,
      extracted,
      nowIso: "2026-03-01T12:00:00.000Z",
    });

    expect(summary).toEqual({ extracted: 3, created: 1, updated: 1, duplicates: 1 });
    expect(store.commitments).toHaveLength(1);
    expect(store.commitments[0]?.provenance).toHaveLength(2);
  });
});

describe("memory execution loop status transitions", () => {
  it("enforces deterministic state transitions and closure", () => {
    const extracted = extractDecisionCommitmentsFromRecords({
      records: [
        {
          path: "memory/2026-03-01.md",
          content: "Decision: Ship docs | owner: Ops | due: 2026-03-04",
        },
      ],
    });

    const store = emptyTrackedCommitmentStore();
    ingestExtractedCommitments({ store, extracted, nowIso: "2026-03-01T00:00:00.000Z" });
    const id = store.commitments[0]?.id;
    expect(id).toBeTruthy();

    const updated = updateTrackedCommitment({
      store,
      update: {
        id: id ?? "",
        status: "in_progress",
        nowIso: "2026-03-02T00:00:00.000Z",
      },
    });
    expect(updated.status).toBe("in_progress");

    const closed = closeTrackedCommitment({
      store,
      close: {
        id: id ?? "",
        closureNote: "Delivered",
        nowIso: "2026-03-03T00:00:00.000Z",
      },
    });
    expect(closed.status).toBe("done");
    expect(closed.closedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(closed.closureNote).toBe("Delivered");

    expect(() =>
      updateTrackedCommitment({
        store,
        update: {
          id: id ?? "",
          status: "blocked",
          nowIso: "2026-03-04T00:00:00.000Z",
        },
      }),
    ).toThrow(/Invalid commitment status transition/);
  });

  it("rejects updates that would collide with an existing dedupe key", () => {
    const extracted = extractDecisionCommitmentsFromRecords({
      records: [
        {
          path: "memory/2026-03-01.md",
          content: "Decision: Ship docs | owner: Ops | due: 2026-03-04",
        },
        {
          path: "memory/2026-03-01.md",
          content: "Decision: Prepare launch | owner: Ops | due: 2026-03-05",
        },
      ],
    });

    const store = emptyTrackedCommitmentStore();
    ingestExtractedCommitments({ store, extracted, nowIso: "2026-03-01T00:00:00.000Z" });

    const firstId = store.commitments[0]?.id;
    const secondId = store.commitments[1]?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();

    expect(() =>
      updateTrackedCommitment({
        store,
        update: {
          id: secondId ?? "",
          title: "Ship docs",
          dueDate: "2026-03-04",
          nowIso: "2026-03-02T00:00:00.000Z",
        },
      }),
    ).toThrow(/dedupe key/i);
  });
});

describe("memory execution loop reminders", () => {
  it("builds reminder digests and heartbeat-compatible output", () => {
    const store = emptyTrackedCommitmentStore();
    const extracted = extractDecisionCommitmentsFromRecords({
      records: [
        {
          path: "memory/2026-03-01.md",
          content: [
            "Decision: Overdue item | owner: sam | due: 2026-03-04",
            "Decision: Upcoming item | owner: sam | due: 2026-03-06",
            "Decision: Closed item | owner: sam | due: 2026-03-06 | status: done",
          ].join("\n"),
        },
      ],
      extractedAt: "2026-03-01T00:00:00.000Z",
    });
    ingestExtractedCommitments({ store, extracted, nowIso: "2026-03-01T00:00:00.000Z" });

    const digest = buildReminderDigest({
      store,
      check: {
        nowIso: "2026-03-05T12:00:00.000Z",
        windowHours: 48,
      },
    });

    expect(digest.overdueCount).toBe(1);
    expect(digest.dueSoonCount).toBe(1);
    expect(digest.items).toHaveLength(2);
    expect(renderReminderDigest({ digest, mode: "plain" })).toContain("[OVERDUE]");

    const emptyDigest = buildReminderDigest({
      store,
      check: {
        nowIso: "2026-03-10T12:00:00.000Z",
        windowHours: 1,
        owner: "nobody",
      },
    });
    expect(renderReminderDigest({ digest: emptyDigest, mode: "heartbeat" })).toBe("HEARTBEAT_OK");
  });
});

describe("memory execution loop persistence", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("loads, saves, and updates store file atomically", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-execution-loop-"));
    const storePath = path.join(tmpDir, "commitments.json");

    const store = emptyTrackedCommitmentStore();
    const extracted = extractDecisionCommitmentsFromRecords({
      records: [
        {
          path: "memory/2026-03-01.md",
          content: "Decision: Persist me | owner: jamie | due: 2026-03-11",
        },
      ],
      extractedAt: "2026-03-01T00:00:00.000Z",
    });
    ingestExtractedCommitments({ store, extracted, nowIso: "2026-03-01T00:00:00.000Z" });

    await saveTrackedCommitmentStore({ storePath, store });
    const loaded = await loadTrackedCommitmentStore(storePath);
    expect(loaded.commitments).toHaveLength(1);

    const id = loaded.commitments[0]?.id ?? "";
    await updateTrackedCommitmentStore({
      storePath,
      mutator: (mutableStore) => {
        updateTrackedCommitment({
          store: mutableStore,
          update: { id, status: "in_progress", nowIso: "2026-03-02T00:00:00.000Z" },
        });
      },
    });

    const after = await loadTrackedCommitmentStore(storePath);
    const listed = listTrackedCommitments({ store: after, filter: { includeClosed: true } });
    expect(listed[0]?.status).toBe("in_progress");
  });
});
