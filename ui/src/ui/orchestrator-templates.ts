export type OrchestratorTemplate = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  icon:
    | "barChart"
    | "book"
    | "bug"
    | "fileText"
    | "scrollText"
    | "settings"
    | "zap"
    | "folder"
    | "radio";
  prompt: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  cleanup?: "keep" | "delete";
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function hydrateTemplatePrompt(prompt: string, now = new Date()): string {
  const today = formatIsoDate(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = formatIsoDate(yesterdayDate);

  return prompt
    .replaceAll("{{TODAY}}", today)
    .replaceAll("{{YESTERDAY}}", yesterday);
}

export const ORCHESTRATOR_TEMPLATES: OrchestratorTemplate[] = [
  {
    id: "daily-brief",
    title: "Daily Brief",
    description: "Turn workspace memory, running state, and calendar into a crisp action plan.",
    tags: ["daily", "planning", "ops"],
    icon: "barChart",
    prompt: [
      "Build a daily brief for Spencer.",
      "",
      "Context to load:",
      "- Read `SOUL.md` and `USER.md` (assistant identity + preferences).",
      "- Read `memory/{{TODAY}}.md` and `memory/{{YESTERDAY}}.md` for recent context.",
      "- Skim `README.md` and `memory/decisions.md` for current direction.",
      "",
      "If available and safe, also check:",
      "- `scripts/healthcheck.sh` for system status (attach key PASS/WARN/FAIL lines).",
      "",
      "Deliverable (bullets, no fluff):",
      "- BLUF (1-2 sentences)",
      "- Top 3 actions for today (each with 'why', and a next concrete step)",
      "- Risks/blocks (if any) with proposed mitigation",
      "- Notes to remember (if any)",
    ].join("\n"),
  },
  {
    id: "repo-doctor",
    title: "Repo Doctor",
    description: "Run the repo health gates and summarize what is green, yellow, and red.",
    tags: ["ops", "health", "quality"],
    icon: "settings",
    prompt: [
      "Run the repository doctor checks and summarize results with evidence.",
      "",
      "Steps:",
      "1. Run `scripts/validate_contract.sh` (capture PASS/FAIL and key warnings).",
      "2. Run `scripts/healthcheck.sh` (capture PASS/FAIL summary).",
      "3. Run `scripts/acceptance.sh` (capture PASS/FAIL summary).",
      "",
      "Rules:",
      "- Do not print secrets or environment variables.",
      "- If anything fails, identify the first failing check and the smallest fix.",
      "",
      "Deliverable:",
      "- Status table (Gate -> PASS/WARN/FAIL)",
      "- Evidence (key output lines)",
      "- Proposed fixes (ordered, smallest-first)",
    ].join("\n"),
    timeoutSeconds: 900,
  },
  {
    id: "skills-audit",
    title: "Skills Audit",
    description: "Verify skills are safe and consistent, then propose upgrades to the weakest ones.",
    tags: ["skills", "security", "quality"],
    icon: "scrollText",
    prompt: [
      "Audit skills for correctness, safety, and consistency.",
      "",
      "Steps:",
      "1. Run `scripts/skills_check.sh` and summarize any failures.",
      "2. Run `scripts/scan_skills_security.sh` and report findings.",
      "3. Spot-check the top 5 most-used skills for clarity and prompt-injection hardening.",
      "",
      "Deliverable:",
      "- Findings (ordered by severity)",
      "- Concrete patches (file paths + minimal diffs) for the top issues",
      "- Suggested new templates or missing skills (optional, 3 max)",
    ].join("\n"),
    timeoutSeconds: 900,
  },
  {
    id: "memory-curation",
    title: "Memory Curation",
    description: "Distill recent daily notes into long-term memory and decisions.",
    tags: ["memory", "writing", "continuity"],
    icon: "book",
    prompt: [
      "Curate Spencer's memory files based on the last 2 days.",
      "",
      "Steps:",
      "1. Read `memory/{{TODAY}}.md` and `memory/{{YESTERDAY}}.md`.",
      "2. Extract durable facts, preferences, and pointers that belong in `MEMORY.md`.",
      "3. Add or update any durable decisions in `memory/decisions.md`.",
      "",
      "Rules:",
      "- Keep it curated (no raw logs).",
      "- Avoid copying secrets into memory. If something looks sensitive, do not persist it.",
      "",
      "Deliverable:",
      "- A short summary of what you added/changed",
      "- Apply the edits directly to `MEMORY.md` and `memory/decisions.md`",
    ].join("\n"),
    timeoutSeconds: 600,
  },
  {
    id: "incident-triage",
    title: "Incident Triage",
    description: "Triage a failing system, starting from logs and health endpoints.",
    tags: ["ops", "debug", "incident"],
    icon: "radio",
    prompt: [
      "Triage an incident in this workspace.",
      "",
      "Steps:",
      "1. Run `scripts/healthcheck.sh` and identify any RED/YELLOW statuses.",
      "2. Inspect recent logs under `logs/` (and any referenced service logs).",
      "3. Identify likely root cause and the fastest rollback/fix.",
      "",
      "Deliverable:",
      "- What is broken (symptoms)",
      "- Root cause hypothesis (with evidence)",
      "- Fix plan (smallest-first), including exact commands to run",
      "- Postmortem notes (1 paragraph): what to automate to prevent recurrence",
    ].join("\n"),
    timeoutSeconds: 900,
  },
  {
    id: "security-sweep",
    title: "Security Sweep",
    description: "Run the local security checks and tighten any obvious footguns.",
    tags: ["security", "quality"],
    icon: "bug",
    prompt: [
      "Perform a quick security sweep focused on local risks (no external scanning).",
      "",
      "Steps:",
      "1. Run `scripts/scan_skills_security.sh` and summarize results.",
      "2. Review `config/.env.example` and `config/workspace.env.example` for unsafe defaults.",
      "3. Scan for obvious secret leaks or debug endpoints in docs/config.",
      "",
      "Deliverable:",
      "- Findings (ordered by severity)",
      "- Minimal patches (with file paths) to fix high-impact issues",
      "- Any follow-ups for Spencer (max 3)",
    ].join("\n"),
    timeoutSeconds: 600,
  },
  {
    id: "evals-regression",
    title: "Evals Regression",
    description: "Run evals and report any regressions with the failing cases.",
    tags: ["quality", "evals", "routing"],
    icon: "fileText",
    prompt: [
      "Run evals and report regressions.",
      "",
      "Steps:",
      "1. Run `scripts/evals_run.sh`.",
      "2. If failures exist, identify the smallest set of changes that caused them (git diff hints are OK).",
      "3. Propose fixes and re-run the minimum subset to validate.",
      "",
      "Deliverable:",
      "- PASS/WARN/FAIL summary",
      "- Failing cases (names) and why they failed",
      "- Proposed fix plan (or patch if straightforward)",
    ].join("\n"),
    timeoutSeconds: 900,
  },
  {
    id: "doc-polish",
    title: "Docs Polish",
    description: "Improve one high-value doc for clarity, structure, and ruthless brevity.",
    tags: ["docs", "writing"],
    icon: "folder",
    prompt: [
      "Pick one high-value doc and improve it.",
      "",
      "Selection criteria:",
      "- Frequently referenced OR currently misleading/outdated.",
      "",
      "Steps:",
      "1. Scan `README.md`, `DGX_SPARK_BACKEND_TEAM_REVIEW.md`, and `REPOSITORY_AUDIT_REPORT.md` for the biggest clarity gap.",
      "2. Choose one doc to improve and apply edits directly.",
      "",
      "Rules:",
      "- Prefer bullet structure and concrete commands/paths.",
      "- Do not add fluff. Remove duplication aggressively.",
      "",
      "Deliverable:",
      "- Which doc you chose and why",
      "- Summary of the edit (before/after bullets)",
    ].join("\n"),
    timeoutSeconds: 600,
  },
  {
    id: "agent-template-builder",
    title: "Agent Template Builder",
    description: "Design a new reusable sub-agent template prompt for a recurring workflow.",
    tags: ["agents", "templates", "ux"],
    icon: "zap",
    prompt: [
      "Design a new sub-agent template for a recurring daily workflow in this workspace.",
      "",
      "Steps:",
      "1. Review `skills/` to understand available agent capabilities.",
      "2. Review `memory/` to understand recurring patterns and needs.",
      "3. Propose ONE new template with:",
      "   - Title",
      "   - Description",
      "   - Tags",
      "   - Prompt (with clear steps and output format)",
      "",
      "Deliverable:",
      "- The full template definition (ready to paste into the UI templates list)",
    ].join("\n"),
    timeoutSeconds: 600,
  },
];

