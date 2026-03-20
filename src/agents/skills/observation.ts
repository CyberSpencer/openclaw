import { createSubsystemLogger } from "../../logging/subsystem.js";

const skillsLogger = createSubsystemLogger("skills");

export type SkillPromptSource = "snapshot" | "entries" | "none";
export type SkillCommandDispatchKind = "prompt_rewrite" | "tool";

type SkillCommandObservation = {
  sessionKey?: string;
  skillName: string;
  commandName: string;
  dispatchKind: SkillCommandDispatchKind;
  toolName?: string;
  hasArgs: boolean;
  observedAt: number;
};

type SkillDocReadObservation = {
  skillName: string;
  filePath: string;
  toolCallId: string;
  observedAt: number;
};

type RunSkillObservation = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  promptSource: SkillPromptSource;
  promptChars: number;
  availableSkillNames: string[];
  commandInvocations: SkillCommandObservation[];
  docReads: SkillDocReadObservation[];
  observedAt: number;
};

const pendingPromptRewriteCommands = new Map<string, SkillCommandObservation>();
const activeRunObservations = new Map<string, RunSkillObservation>();

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function parseSkillNamesFromPrompt(prompt: string): string[] {
  if (!prompt.trim()) {
    return [];
  }
  const matches = prompt.matchAll(/<name>\s*([^<]+?)\s*<\/name>/gi);
  const names: string[] = [];
  for (const match of matches) {
    const name = match[1]?.trim();
    if (name) {
      names.push(name);
    }
  }
  return uniqueStrings(names);
}

function resolveSkillDocRead(filePath: string): { skillName: string; filePath: string } | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const baseName = segments.at(-1)?.toLowerCase();
  if (baseName !== "skill.md") {
    return null;
  }
  const skillName = segments.at(-2)?.trim();
  if (!skillName) {
    return null;
  }
  return { skillName, filePath: trimmed };
}

function buildSelectionSource(params: {
  readSkillNames: string[];
  invokedSkillNames: string[];
}): "read_tool" | "slash_command" | "mixed" | "none" {
  const hasReads = params.readSkillNames.length > 0;
  const hasCommands = params.invokedSkillNames.length > 0;
  if (hasReads && hasCommands) {
    return "mixed";
  }
  if (hasReads) {
    return "read_tool";
  }
  if (hasCommands) {
    return "slash_command";
  }
  return "none";
}

function buildSelectionReason(params: {
  promptSource: SkillPromptSource;
  readSkillNames: string[];
  commandInvocations: SkillCommandObservation[];
}): string {
  const selectionSource = buildSelectionSource({
    readSkillNames: params.readSkillNames,
    invokedSkillNames: uniqueStrings(params.commandInvocations.map((entry) => entry.skillName)),
  });
  if (selectionSource === "mixed") {
    const commands = params.commandInvocations
      .map((entry) => `/${entry.commandName}→${entry.skillName}`)
      .join(", ");
    return `Explicit skill command observed (${commands}) and the run also read SKILL.md.`;
  }
  if (selectionSource === "slash_command") {
    const commands = params.commandInvocations
      .map((entry) => `/${entry.commandName}→${entry.skillName}`)
      .join(", ");
    return `Explicit skill command observed (${commands}).`;
  }
  if (selectionSource === "read_tool") {
    return "Model read SKILL.md via the read tool after seeing available skills.";
  }
  if (params.promptSource === "none") {
    return "No skills were offered in the prompt for this run.";
  }
  return "Skills were available, but no SKILL.md read or explicit skill command was observed.";
}

export function observeSkillCommandInvocation(params: {
  sessionKey?: string;
  skillName: string;
  commandName: string;
  dispatchKind: SkillCommandDispatchKind;
  toolName?: string;
  hasArgs: boolean;
}) {
  const observation: SkillCommandObservation = {
    sessionKey: params.sessionKey?.trim() || undefined,
    skillName: params.skillName.trim(),
    commandName: params.commandName.trim(),
    dispatchKind: params.dispatchKind,
    toolName: params.toolName?.trim() || undefined,
    hasArgs: params.hasArgs,
    observedAt: Date.now(),
  };
  if (!observation.skillName || !observation.commandName) {
    return;
  }
  if (observation.dispatchKind === "prompt_rewrite" && observation.sessionKey) {
    pendingPromptRewriteCommands.set(observation.sessionKey, observation);
  }
  skillsLogger.info("Skill command invoked", {
    event: "skill_command_invoked",
    sessionKey: observation.sessionKey,
    skillName: observation.skillName,
    commandName: observation.commandName,
    dispatchKind: observation.dispatchKind,
    toolName: observation.toolName,
    hasArgs: observation.hasArgs,
    consoleMessage: `skill command invoked: skill=${observation.skillName} command=/${observation.commandName} dispatch=${observation.dispatchKind}${observation.toolName ? ` tool=${observation.toolName}` : ""}`,
  });
}

export function observeSkillsPromptResolved(params: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  prompt: string;
  promptSource: SkillPromptSource;
}) {
  const sessionKey = params.sessionKey?.trim() || undefined;
  const pendingCommand = sessionKey ? pendingPromptRewriteCommands.get(sessionKey) : undefined;
  if (sessionKey && pendingCommand) {
    pendingPromptRewriteCommands.delete(sessionKey);
  }
  const availableSkillNames = parseSkillNamesFromPrompt(params.prompt);
  const observation: RunSkillObservation = {
    runId: params.runId,
    sessionId: params.sessionId?.trim() || undefined,
    sessionKey,
    workspaceDir: params.workspaceDir,
    promptSource: params.promptSource,
    promptChars: params.prompt.length,
    availableSkillNames,
    commandInvocations: pendingCommand ? [pendingCommand] : [],
    docReads: [],
    observedAt: Date.now(),
  };
  activeRunObservations.set(params.runId, observation);
  skillsLogger.info("Skills prompt resolved", {
    event: "skills_prompt_resolved",
    runId: params.runId,
    sessionId: observation.sessionId,
    sessionKey,
    workspaceDir: params.workspaceDir,
    promptSource: params.promptSource,
    promptChars: params.prompt.length,
    availableSkillCount: availableSkillNames.length,
    availableSkillNames,
    explicitSkillCommand: pendingCommand
      ? {
          skillName: pendingCommand.skillName,
          commandName: pendingCommand.commandName,
          dispatchKind: pendingCommand.dispatchKind,
        }
      : undefined,
    consoleMessage: `skills prompt resolved: runId=${params.runId} source=${params.promptSource} available=${availableSkillNames.length}${pendingCommand ? ` explicit=${pendingCommand.skillName}` : ""}`,
  });
}

export function observeSkillDocRead(params: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  toolCallId: string;
  filePath: string;
}) {
  const resolved = resolveSkillDocRead(params.filePath);
  if (!resolved) {
    return;
  }
  const observation = activeRunObservations.get(params.runId);
  const docRead: SkillDocReadObservation = {
    skillName: resolved.skillName,
    filePath: resolved.filePath,
    toolCallId: params.toolCallId,
    observedAt: Date.now(),
  };
  if (
    observation &&
    !observation.docReads.some(
      (entry) => entry.toolCallId === docRead.toolCallId && entry.filePath === docRead.filePath,
    )
  ) {
    observation.docReads.push(docRead);
  }
  skillsLogger.info("Skill doc read", {
    event: "skill_doc_read",
    runId: params.runId,
    sessionId: params.sessionId?.trim() || observation?.sessionId,
    sessionKey: params.sessionKey?.trim() || observation?.sessionKey,
    skillName: docRead.skillName,
    filePath: docRead.filePath,
    toolCallId: docRead.toolCallId,
    trackedRun: Boolean(observation),
    consoleMessage: `skill doc read: runId=${params.runId} skill=${docRead.skillName} toolCallId=${docRead.toolCallId}`,
  });
}

export function finalizeRunSkillUsageObservation(params: { runId: string; sessionId?: string }) {
  const observation = activeRunObservations.get(params.runId);
  if (!observation) {
    return;
  }
  activeRunObservations.delete(params.runId);

  const readSkillNames = uniqueStrings(observation.docReads.map((entry) => entry.skillName));
  const invokedSkillNames = uniqueStrings(
    observation.commandInvocations.map((entry) => entry.skillName),
  );
  const selectedSkillNames = uniqueStrings([...invokedSkillNames, ...readSkillNames]);
  const selectionSource = buildSelectionSource({ readSkillNames, invokedSkillNames });
  const selectionReason = buildSelectionReason({
    promptSource: observation.promptSource,
    readSkillNames,
    commandInvocations: observation.commandInvocations,
  });
  const skillUsed = selectedSkillNames.length > 0;

  skillsLogger.info(skillUsed ? "Skill usage summary" : "No skill used during run", {
    event: "skill_usage_summary",
    runId: params.runId,
    sessionId: params.sessionId?.trim() || observation.sessionId,
    sessionKey: observation.sessionKey,
    workspaceDir: observation.workspaceDir,
    promptSource: observation.promptSource,
    promptChars: observation.promptChars,
    availableSkillCount: observation.availableSkillNames.length,
    availableSkillNames: observation.availableSkillNames,
    skillUsed,
    noSkillUsed: !skillUsed,
    selectionSource,
    selectionReason,
    selectedSkillNames,
    readSkillNames,
    invokedSkillNames,
    commandInvocations: observation.commandInvocations.map((entry) => ({
      skillName: entry.skillName,
      commandName: entry.commandName,
      dispatchKind: entry.dispatchKind,
      toolName: entry.toolName,
      hasArgs: entry.hasArgs,
    })),
    skillDocReads: observation.docReads.map((entry) => ({
      skillName: entry.skillName,
      filePath: entry.filePath,
      toolCallId: entry.toolCallId,
    })),
    consoleMessage: skillUsed
      ? `skill usage summary: runId=${params.runId} source=${selectionSource} selected=${selectedSkillNames.join(",")}`
      : `no skill used during run: runId=${params.runId} promptSource=${observation.promptSource} available=${observation.availableSkillNames.length}`,
  });
}

export function discardRunSkillUsageObservation(runId: string) {
  activeRunObservations.delete(runId);
}

export function resetSkillUsageObservationsForTesting() {
  pendingPromptRewriteCommands.clear();
  activeRunObservations.clear();
}

export const __testing = {
  parseSkillNamesFromPrompt,
  resolveSkillDocRead,
};
