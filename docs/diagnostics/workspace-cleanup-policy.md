# Workspace Cleanup Policy (ENG-201/202/203)

This policy defines safe cleanup rules for transient workspace artifacts, Python virtual environments, and duplicated `node_modules` trees.

## Goals

- Keep active worktrees fast and reproducible.
- Remove stale local artifacts without deleting source-controlled content.
- Prefer dry-run first, then explicit apply.

## 1) Transient artifact retention policy

### Covered paths

- `tmp/openclaw-core`
- `.tmp/openclaw-core`
- `_merge_review/*/openclaw-core`

### Retention defaults

- Keep artifacts newer than **7 days**.
- Anything older than 7 days is eligible for cleanup.
- Dry-run is required before deletion.

### Automation script

Use `scripts/workspace-cleanup.sh`.

Examples:

```bash
# Dry-run default discovery under workspace root
scripts/workspace-cleanup.sh --workspace-root ~/clawd

# Apply deletion for default stale artifact paths
scripts/workspace-cleanup.sh --workspace-root ~/clawd --apply
```

## 2) Python virtual environment policy

### Canonical approach

- Use **one canonical env per Python project**.
- Prefer `.venv/` naming for project-local virtual environments.
- Avoid keeping both `venv/` and `.venv/` in the same project unless there is an explicit migration window.

### Shared vs isolated guidance

- **Isolated env (default):** project-specific dependencies, conflicting binary stacks, or strict lockfile pinning.
- **Shared env (exception):** tiny helper scripts with identical dependency sets and no compiled deps.

### Safe removal rules

Before removing an env:

1. Confirm lock material exists (`pyproject.toml`, `uv.lock`, `requirements*.txt`, or constraints files).
2. Confirm a canonical replacement env exists (or recreation command is documented).
3. Run a lightweight smoke check for key Python-backed skills/workflows.

## 3) `node_modules` worktree policy

### Active vs inactive worktree model

- **Active worktrees:** currently used for daily development, testing, or runtime.
- **Inactive worktrees:** archived review trees, one-off experiments, dated snapshots, and abandoned branches.

### Rules

- Keep `node_modules` only in active worktrees.
- Remove `node_modules` from inactive worktrees/snapshots.
- Rebuild on demand using:

```bash
pnpm install --frozen-lockfile
```

### Expected install footprint by role

- **Active core workspace:** large `node_modules` is expected and retained.
- **Archived/review snapshots:** `node_modules` should not be retained long term.

## 4) Operational checklist

1. Capture before snapshot (`du -sh`).
2. Run cleanup script in dry-run mode.
3. Apply cleanup.
4. Capture after snapshot.
5. Run smoke gates on active worktrees.
6. Post reclaimed-space evidence to the tracking issue.
