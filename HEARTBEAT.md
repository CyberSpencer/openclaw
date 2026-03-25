# HEARTBEAT.md

## Jarvis Autonomous Work Driver

Run: `~/clawd/scripts/jarvis-driver.sh --check-stale`

Read the JSON output from stdout:

**`{"action": "idle"}`** → Nothing to do. Reply: HEARTBEAT_OK

**`{"action": "complete", ...}`** → All tasks done. Run completion sequence:

1. `cd ~/clawd/core && git push aii-private main && git push fork main` (if there are unpushed commits)
2. `cd ~/clawd && git push origin $(git branch --show-current)`
3. Write overnight summary to `~/clawd/artifacts/nightly/overnight-summary-$(date +%Y-%m-%d).md`
4. Copy to Desktop: `cp ~/clawd/artifacts/nightly/overnight-summary-*.md ~/Desktop/`
5. Update `~/clawd/.jarvis/status.json` → set `phase = "idle"`, `plan_id = null`
6. Reply: HEARTBEAT_OK

**`{"action": "spawn", "task": {...}}`** → Spawn a subagent:

1. Use `task.model` as the model
2. Use `task.timeout_min * 60` as `runTimeoutSeconds` (aligns gateway kill-timeout with Jarvis stale threshold)
3. Use `"jarvis:<task.id>"` as the `label` (enables auto-announce routing back to Jarvis)
4. Use `task.instructions` as the task prompt — append to it: "When done, run: `openclaw system event --text 'Task <task.id> complete: <one line summary>' --mode now`"
5. After spawning, call: `~/clawd/scripts/jarvis-task.sh start <task.id> <subagent_session_key>`
6. Reply with a brief note on what's running

**On subagent completion announcements** (system events like "Task XXXX complete"):

1. Parse the task ID from the event text
2. **Dedup check:** `test -f ~/clawd/.jarvis/queue/done/<id>.json` — if the file exists, the task was already handled; skip and reply HEARTBEAT_OK
3. Run: `~/clawd/scripts/jarvis-task.sh verify <id>`
4. If PASS: `~/clawd/scripts/jarvis-task.sh done <id> "<summary>"`
5. If FAIL: `~/clawd/scripts/jarvis-task.sh fail <id> "<error>"`
6. Immediately run `~/clawd/scripts/jarvis-driver.sh` (no --check-stale) to get next action
7. If next action is `spawn`: spawn the next subagent right away

**On auto-announce messages** (messages starting with `A subagent task "jarvis:<id>"` — delivered automatically by the gateway when a subagent finishes):

1. Extract the task ID: the label format is `jarvis:<task.id>` — extract `<task.id>`
2. **Dedup check:** `test -f ~/clawd/.jarvis/queue/done/<id>.json` — if the file exists, already handled; skip
3. Run: `~/clawd/scripts/jarvis-task.sh verify <id>`
4. If PASS: `~/clawd/scripts/jarvis-task.sh done <id> "<summary from Findings section>"`
5. If FAIL: `~/clawd/scripts/jarvis-task.sh fail <id> "<error>"`
6. Immediately run `~/clawd/scripts/jarvis-driver.sh` (no --check-stale) to get next action
7. If next action is `spawn`: spawn the next subagent right away
8. Do NOT produce a user-facing summary — reply with a brief internal status note only

Note: both announcement paths (system event and auto-announce) are active; whichever arrives first wins. The dedup check ensures the second is a no-op. If the subagent crashes before calling `openclaw system event`, the auto-announce still rescues the task.

**Notes:**

- Never reply HEARTBEAT_OK if there are active or pending tasks (check `jarvis-task.sh status` if unsure)
- If `.jarvis/status.json` phase is "idle": always HEARTBEAT_OK
- **Sub-agent spawning rule (all threads):** Any task — whether from the queue or arising in any main agent chat/thread — that is expected to take over 30 seconds must be handed off to a sub-agent. Do not execute long-running work inline in the main agent. Spawn a sub-agent with the full task context, then monitor via the completion announcement pattern above.
