#!/usr/bin/env bash
# jarvis-plan.sh — Convert nightly plan templates into dated task queue files
#
# Usage:
#   jarvis-plan.sh create <template_id> [--date YYYY-MM-DD] [--dry-run]
#   jarvis-plan.sh status
#   jarvis-plan.sh archive

set -euo pipefail

JARVIS_DIR="$HOME/clawd/.jarvis"
TEMPLATES_DIR="$JARVIS_DIR/plans/templates"
PENDING_DIR="$JARVIS_DIR/queue/pending"
ACTIVE_DIR="$JARVIS_DIR/queue/active"
DONE_DIR="$JARVIS_DIR/queue/done"
FAILED_DIR="$JARVIS_DIR/queue/failed"
PLANS_DIR="$JARVIS_DIR/plans"
ARCHIVE_DIR="$JARVIS_DIR/plans/archive"
STATUS_FILE="$JARVIS_DIR/status.json"

cmd="${1:-}"
shift 2>/dev/null || true

case "$cmd" in

  # ─── CREATE ────────────────────────────────────────────────────────────────
  create)
    template_id="${1:-}"
    if [[ -z "$template_id" ]]; then
      echo "Usage: jarvis-plan.sh create <template_id> [--date YYYY-MM-DD] [--dry-run]" >&2
      exit 1
    fi
    shift 2>/dev/null || true

    date_val=$(date +%Y-%m-%d)
    dry_run="false"

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --date)
          date_val="$2"
          shift 2
          ;;
        --dry-run)
          dry_run="true"
          shift
          ;;
        *)
          echo "Unknown option: $1" >&2
          exit 1
          ;;
      esac
    done

    template_file="$TEMPLATES_DIR/${template_id}.json"
    if [[ ! -f "$template_file" ]]; then
      echo "Template not found: $template_file" >&2
      exit 1
    fi

    # Ensure output dirs exist
    mkdir -p "$PENDING_DIR" "$PLANS_DIR" "$ARCHIVE_DIR"

    DATE="$date_val" \
    DRY_RUN="$dry_run" \
    TEMPLATE_FILE="$template_file" \
    PENDING_DIR_PY="$PENDING_DIR" \
    PLANS_DIR_PY="$PLANS_DIR" \
    JARVIS_DIR_PY="$JARVIS_DIR" \
    python3 << 'PYEOF'
import os, json, sys
from datetime import datetime, timezone

date_val     = os.environ["DATE"]
dry_run      = os.environ.get("DRY_RUN", "false") == "true"
template_file = os.environ["TEMPLATE_FILE"]
pending_dir  = os.environ["PENDING_DIR_PY"]
plans_dir    = os.environ["PLANS_DIR_PY"]
jarvis_dir   = os.environ["JARVIS_DIR_PY"]

with open(template_file) as f:
    template = json.load(f)

now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# ── First pass: collect task IDs per phase (needed for dependency resolution) ──
phase_task_ids = {}   # phase_num -> [task_id, ...]
task_list      = []   # (id, phase_num, wave_num, wave_obj, task_tmpl)

for phase_obj in template.get("phases", []):
    phase_num = phase_obj["phase"]
    phase_task_ids[phase_num] = []
    for wave_obj in phase_obj.get("waves", []):
        wave_num = wave_obj["wave"]
        task_n = 1
        for task_tmpl in wave_obj.get("tasks", []):
            task_id = f"{date_val}-{phase_num}-{wave_num}-{task_n}"
            phase_task_ids[phase_num].append(task_id)
            task_list.append((task_id, phase_num, wave_num, wave_obj, task_tmpl))
            task_n += 1

# ── Helper: replace {DATE} in strings and lists ──
def replace_date(val):
    if isinstance(val, str):
        return val.replace("{DATE}", date_val)
    if isinstance(val, list):
        return [replace_date(x) for x in val]
    return val

# ── Second pass: build full task objects ──
tasks = []
for task_id, phase_num, wave_num, wave_obj, task_tmpl in task_list:
    deps_phases  = wave_obj.get("dependencies_phases", [])
    dependencies = []
    for dep_phase in deps_phases:
        dependencies.extend(phase_task_ids.get(dep_phase, []))

    task = {
        "id":            task_id,
        "plan_id":       f"{template['template_id']}-{date_val}",
        "phase":         phase_num,
        "wave":          wave_num,
        "name":          replace_date(task_tmpl.get("name_template", "")),
        "priority":      task_tmpl.get("priority", 5),
        "dependencies":  dependencies,
        "model":         task_tmpl.get("model", "sonnet"),
        "timeout_min":   task_tmpl.get("timeout_min", 30),
        "max_attempts":  task_tmpl.get("max_attempts", 2),
        "instructions":  replace_date(task_tmpl.get("instructions_template", "")),
        "artifacts":     replace_date(task_tmpl.get("artifacts_template", [])),
        "verify":        replace_date(task_tmpl.get("verify_template", "")),
        "done_criteria": task_tmpl.get("done_criteria", ""),
        "status":        "pending",
        "created_at":    now_iso,
        "started_at":    None,
        "completed_at":  None,
        "attempts":      0,
        "subagent_key":  None,
        "result_summary": None,
        "failure_reason": None,
        "retry_note":    None,
    }
    tasks.append(task)

# ── Dry run: print only ──
if dry_run:
    plan_id = f"{template['template_id']}-{date_val}"
    num_phases = len(template.get("phases", []))
    print(f"[DRY RUN] Plan {plan_id}: {len(tasks)} tasks across {num_phases} phases")
    print()
    for t in tasks:
        deps_str = ""
        if t["dependencies"]:
            deps_str = f"\n      depends on: {', '.join(t['dependencies'])}"
        print(f"  [{t['id']}]  Phase {t['phase']} Wave {t['wave']}  —  {t['name']}")
        print(f"    model={t['model']}  timeout={t['timeout_min']}min  max_attempts={t['max_attempts']}{deps_str}")
    sys.exit(0)

# ── Write task files to pending/ ──
for t in tasks:
    task_file = os.path.join(pending_dir, f"{t['id']}.json")
    with open(task_file, "w") as f:
        json.dump(t, f, indent=2)
        f.write("\n")

# ── Write active.json ──
plan_id = f"{template['template_id']}-{date_val}"
active = {
    "plan_id":    plan_id,
    "template":   template["template_id"],
    "created_at": now_iso,
    "date":       date_val,
    "task_ids":   [t["id"] for t in tasks],
}
with open(os.path.join(plans_dir, "active.json"), "w") as f:
    json.dump(active, f, indent=2)
    f.write("\n")

# ── Write status.json ──
status = {
    "plan_id":       plan_id,
    "phase":         "executing",
    "started_at":    now_iso,
    "last_activity": now_iso,
    "tasks_total":   len(tasks),
    "tasks_pending": len(tasks),
    "tasks_active":  0,
    "tasks_done":    0,
    "tasks_failed":  0,
    "current_wave":  1,
    "active_task_ids": [],
    "errors":        [],
}
with open(os.path.join(jarvis_dir, "status.json"), "w") as f:
    json.dump(status, f, indent=2)
    f.write("\n")

num_phases = len(template.get("phases", []))
print(f"Plan {plan_id} created: {len(tasks)} tasks queued across {num_phases} phases")
PYEOF
    ;;

  # ─── STATUS ────────────────────────────────────────────────────────────────
  status)
    if [[ ! -f "$PLANS_DIR/active.json" ]]; then
      echo "No active plan."
      if [[ -f "$STATUS_FILE" ]]; then
        phase=$(python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d.get('phase','idle'))")
        echo "Status: $phase"
      fi
      exit 0
    fi

    PENDING_DIR_PY="$PENDING_DIR" \
    ACTIVE_DIR_PY="$ACTIVE_DIR" \
    DONE_DIR_PY="$DONE_DIR" \
    FAILED_DIR_PY="$FAILED_DIR" \
    PLANS_DIR_PY="$PLANS_DIR" \
    STATUS_FILE_PY="$STATUS_FILE" \
    python3 << 'PYEOF'
import os, json

pending_dir = os.environ["PENDING_DIR_PY"]
active_dir  = os.environ["ACTIVE_DIR_PY"]
done_dir    = os.environ["DONE_DIR_PY"]
failed_dir  = os.environ["FAILED_DIR_PY"]
plans_dir   = os.environ["PLANS_DIR_PY"]
status_file = os.environ["STATUS_FILE_PY"]

with open(os.path.join(plans_dir, "active.json")) as f:
    active = json.load(f)

with open(status_file) as f:
    status = json.load(f)

print(f"Plan:    {active['plan_id']}  ({status['phase']})")
print(f"Tasks:   ✅ {status['tasks_done']} done  |  🔄 {status['tasks_active']} active  "
      f"|  ⏳ {status['tasks_pending']} pending  |  ❌ {status['tasks_failed']} failed  "
      f"[{status['tasks_total']} total]")
if status.get("errors"):
    print(f"Errors:  " + "; ".join(status["errors"]))
print()

def load_task(task_id):
    for d in [pending_dir, active_dir, done_dir, failed_dir]:
        fpath = os.path.join(d, f"{task_id}.json")
        if os.path.exists(fpath):
            with open(fpath) as f:
                return json.load(f)
    return {"id": task_id, "name": "NOT FOUND", "status": "missing", "phase": 0, "wave": 0,
            "model": "?", "attempts": 0, "max_attempts": 0, "dependencies": []}

# Group tasks by phase
phase_tasks = {}
for tid in active.get("task_ids", []):
    t = load_task(tid)
    p = t.get("phase", 0)
    phase_tasks.setdefault(p, []).append(t)

icons = {"pending": "⏳", "active": "🔄", "done": "✅", "failed": "❌", "missing": "❓"}

for phase_num in sorted(phase_tasks.keys()):
    tasks = phase_tasks[phase_num]
    print(f"Phase {phase_num}:")
    for t in tasks:
        icon     = icons.get(t.get("status", "?"), "?")
        wave_str = f"w{t.get('wave', '?')}"
        name     = t.get("name", t["id"])
        model    = t.get("model", "")
        att      = t.get("attempts", 0)
        max_att  = t.get("max_attempts", 2)
        att_str  = f" [{att}/{max_att} attempts]" if att > 0 else ""
        dep_str  = ""
        if t.get("dependencies"):
            dep_str = f" [deps: {len(t['dependencies'])}]"
        print(f"  {icon} [{wave_str}] {t['id']}  {name}  ({model}){att_str}{dep_str}")
        if t.get("failure_reason"):
            print(f"       ⚠ {t['failure_reason']}")
    print()
PYEOF
    ;;

  # ─── ARCHIVE ───────────────────────────────────────────────────────────────
  archive)
    if [[ ! -f "$PLANS_DIR/active.json" ]]; then
      echo "No active plan to archive."
      exit 0
    fi

    mkdir -p "$ARCHIVE_DIR"

    PLANS_DIR_PY="$PLANS_DIR" \
    ARCHIVE_DIR_PY="$ARCHIVE_DIR" \
    STATUS_FILE_PY="$STATUS_FILE" \
    python3 << 'PYEOF'
import os, json, shutil

plans_dir   = os.environ["PLANS_DIR_PY"]
archive_dir = os.environ["ARCHIVE_DIR_PY"]
status_file = os.environ["STATUS_FILE_PY"]

active_plan_file = os.path.join(plans_dir, "active.json")
with open(active_plan_file) as f:
    active = json.load(f)

plan_id = active["plan_id"]
archive_file = os.path.join(archive_dir, f"{plan_id}.json")
shutil.move(active_plan_file, archive_file)
print(f"Archived: {plan_id} → {archive_file}")

idle_status = {
    "plan_id":         None,
    "phase":           "idle",
    "started_at":      None,
    "last_activity":   None,
    "tasks_total":     0,
    "tasks_pending":   0,
    "tasks_active":    0,
    "tasks_done":      0,
    "tasks_failed":    0,
    "current_wave":    None,
    "active_task_ids": [],
    "errors":          [],
}
with open(status_file, "w") as f:
    json.dump(idle_status, f, indent=2)
    f.write("\n")

print("Status reset to idle.")
PYEOF
    ;;

  # ─── HELP ──────────────────────────────────────────────────────────────────
  *)
    echo "Usage: jarvis-plan.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  create <template_id> [--date YYYY-MM-DD] [--dry-run]"
    echo "      Create a plan from a template. Writes task files to .jarvis/queue/pending/"
    echo "      --date     Override the plan date (default: today)"
    echo "      --dry-run  Print tasks without writing any files"
    echo ""
    echo "  status"
    echo "      Show current plan progress and per-task states"
    echo ""
    echo "  archive"
    echo "      Move active.json to plans/archive/ and reset status to idle"
    exit 1
    ;;

esac
