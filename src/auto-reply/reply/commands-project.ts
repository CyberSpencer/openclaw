import type { SessionEntry } from "../../config/sessions.js";
import type { CommandHandler } from "./commands-types.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { listProjects, sanitizeProjectId } from "../../projects/projects.js";

type ProjectMemoryMode = NonNullable<SessionEntry["projectMemoryMode"]>;

type ParsedProjectCommand =
  | { hasCommand: false }
  | {
      hasCommand: true;
      action: "set" | "clear" | "show" | "list" | "mode";
      value: string;
    };

function parseProjectCommand(normalized: string): ParsedProjectCommand {
  const body = normalized.trim();
  if (body !== "/project" && !body.startsWith("/project ")) {
    return { hasCommand: false };
  }
  const rest = body === "/project" ? "" : body.slice("/project".length).trim();
  if (!rest) {
    return { hasCommand: true, action: "show", value: "" };
  }
  const [rawAction, ...tail] = rest.split(/\s+/).filter(Boolean);
  const action = (rawAction || "").trim().toLowerCase();
  const value = tail.join(" ").trim();

  if (action === "set" || action === "clear" || action === "show" || action === "list") {
    return { hasCommand: true, action, value };
  }
  if (action === "mode") {
    return { hasCommand: true, action: "mode", value };
  }

  // If the first token isn't a recognized action, treat it as shorthand for set.
  return { hasCommand: true, action: "set", value: rest };
}

function normalizeMemoryMode(raw: string): ProjectMemoryMode | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "project-only" || value === "project" || value === "only") {
    return "project-only";
  }
  if (value === "project+global" || value === "global" || value === "both") {
    return "project+global";
  }
  return null;
}

export const handleProjectCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseProjectCommand(params.command.commandBodyNormalized);
  if (!parsed.hasCommand) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /project from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const sessionEntry = params.sessionEntry;
  const sessionStore = params.sessionStore;
  const sessionKey = params.sessionKey;

  if (!sessionEntry || !sessionStore || !sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "📦 Project settings unavailable (missing session store)." },
    };
  }

  const currentProjectId = sessionEntry.projectId?.trim() || "";
  const currentMode = sessionEntry.projectMemoryMode ?? "project+global";

  if (parsed.action === "list") {
    const projects = await listProjects(params.workspaceDir);
    if (projects.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "📦 No projects found. Create one under ./projects/<id>/" },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `📦 Projects (${projects.length})\n- ${projects.join("\n- ")}` },
    };
  }

  if (parsed.action === "show") {
    if (!currentProjectId) {
      return {
        shouldContinue: false,
        reply: { text: "📦 No active project. Use /project set <id>." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `📦 Project: ${currentProjectId} (memory: ${currentMode})` },
    };
  }

  if (parsed.action === "clear") {
    delete sessionEntry.projectId;
    delete sessionEntry.projectMemoryMode;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (params.storePath) {
      await updateSessionStore(params.storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
    return {
      shouldContinue: false,
      reply: { text: "📦 Cleared active project." },
    };
  }

  if (parsed.action === "mode") {
    if (!currentProjectId) {
      return {
        shouldContinue: false,
        reply: { text: "📦 Set a project first: /project set <id>" },
      };
    }
    const nextMode = normalizeMemoryMode(parsed.value);
    if (!nextMode) {
      return {
        shouldContinue: false,
        reply: { text: "📦 Usage: /project mode project-only|project+global" },
      };
    }
    sessionEntry.projectMemoryMode = nextMode;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (params.storePath) {
      await updateSessionStore(params.storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
    return {
      shouldContinue: false,
      reply: { text: `📦 Project memory mode set to ${nextMode}.` },
    };
  }

  // set
  const requested = parsed.value.trim();
  if (!requested) {
    return {
      shouldContinue: false,
      reply: { text: "📦 Usage: /project set <id>" },
    };
  }
  const sanitized = sanitizeProjectId(requested);
  if (!sanitized) {
    return {
      shouldContinue: false,
      reply: { text: "📦 Invalid project id." },
    };
  }

  sessionEntry.projectId = sanitized;
  if (!sessionEntry.projectMemoryMode) {
    sessionEntry.projectMemoryMode = "project+global";
  }
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[sessionKey] = sessionEntry;
    });
  }

  const suffix = sanitized !== requested.trim() ? ` (normalized from ${requested.trim()})` : "";
  return {
    shouldContinue: false,
    reply: { text: `📦 Project set to ${sanitized}${suffix}.` },
  };
};
