import path from "node:path";
import type { SessionLockInspection } from "../agents/session-write-lock.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const ZOMBIE_RECOVERY_MSG = "[Agent interrupted — gateway restarted]";

const recoveryLog = createSubsystemLogger("gateway/zombie-recovery");

/**
 * After stale lock removal, scan the session store for zombie sessions — sessions
 * whose transcript file was locked (indicating an active agent run) but whose lock
 * was cleaned up because the gateway crashed. Mark each one as abortedLastRun=true
 * and enqueue a system message so the user sees the interruption notice on next turn.
 */
export async function recoverZombieSessions(params: {
  sessionsDir: string;
  cleaned: SessionLockInspection[];
}): Promise<void> {
  const { sessionsDir, cleaned } = params;
  if (cleaned.length === 0) {
    return;
  }

  // Build a set of transcript paths from the cleaned lock files.
  const zombieTranscriptPaths = new Set<string>();
  for (const lockInfo of cleaned) {
    // Lock path: <sessionsDir>/<name>.jsonl.lock → transcript: <sessionsDir>/<name>.jsonl
    const transcriptPath = lockInfo.lockPath.replace(/\.lock$/, "");
    zombieTranscriptPaths.add(path.resolve(transcriptPath));
  }

  const storePath = path.join(sessionsDir, "sessions.json");
  try {
    await updateSessionStore(storePath, (store) => {
      const now = Date.now();
      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry) {
          continue;
        }
        const { sessionId } = entry;
        if (!sessionId) {
          continue;
        }

        // Resolve the candidate transcript path for this entry.
        // Prefer the stored sessionFile field; fall back to the default <sessionId>.jsonl name.
        const candidatePaths: string[] = [];
        if (entry.sessionFile) {
          candidatePaths.push(path.resolve(sessionsDir, entry.sessionFile));
        }
        candidatePaths.push(path.resolve(sessionsDir, `${sessionId}.jsonl`));

        const isZombie = candidatePaths.some((p) => zombieTranscriptPaths.has(p));
        if (!isZombie) {
          continue;
        }

        recoveryLog.info(`recovering zombie session: key=${sessionKey} sessionId=${sessionId}`);

        entry.abortedLastRun = true;
        entry.updatedAt = now;

        // Enqueue a system event so the interruption notice appears on the user's
        // next turn for this session.
        enqueueSystemEvent(ZOMBIE_RECOVERY_MSG, { sessionKey });
      }
    });
  } catch (err) {
    recoveryLog.warn(`zombie session recovery failed for ${sessionsDir}: ${String(err)}`);
  }
}
