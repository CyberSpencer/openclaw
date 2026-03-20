import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

type ThemeSummary = {
  id: string;
  label: string;
  brief?: string;
  status: "active" | "archived";
  canonicalSessionKey: string;
};

type ThemesListResponse = {
  themes?: ThemeSummary[];
};

type ThemesResolveResponse = {
  theme?: ThemeSummary;
};

function resolveCurrentTheme(
  params: Parameters<CommandHandler>[0],
): Promise<ThemeSummary | undefined> {
  if (!params.sessionKey) {
    return Promise.resolve(undefined);
  }
  return callGateway<ThemesResolveResponse>({
    method: "themes.resolve",
    params: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      includeArchived: true,
    },
    timeoutMs: 10_000,
  }).then((result) => result?.theme);
}

function formatThemeLine(theme: GatewayThemeSummary, currentThemeId?: string) {
  const prefix = theme.id === currentThemeId ? "* " : "- ";
  const brief = theme.brief ? `: ${theme.brief}` : "";
  const suffix = theme.status === "archived" ? " [archived]" : "";
  return `${prefix}${theme.label}${brief}${suffix}`;
}

export const handleThemeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!/^\/theme(?:\s|$)/.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /theme from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice("/theme".length).trim();
  if (!rest) {
    const current = await resolveCurrentTheme(params);
    return {
      shouldContinue: false,
      reply: {
        text: current
          ? `🎯 Current theme: ${current.label}${current.brief ? `\n${current.brief}` : ""}`
          : "🎯 No theme is bound to this session.\nUsage: /theme list | /theme create <label>[: brief] | /theme use <id|label> | /theme clear | /theme brief <text> | /theme archive <id|label>",
      },
    };
  }

  const [command] = rest.split(/\s+/);
  const tail = rest.slice(command.length).trim();
  const subcommand = command.toLowerCase();

  if (subcommand === "list") {
    const current = await resolveCurrentTheme(params);
    const result = await callGateway<ThemesListResponse>({
      method: "themes.list",
      params: { agentId: params.agentId, includeArchived: false },
      timeoutMs: 10_000,
    });
    const lines = (result?.themes ?? []).map((theme) => formatThemeLine(theme, current?.id));
    return {
      shouldContinue: false,
      reply: {
        text: lines.length > 0 ? `🎯 Themes\n${lines.join("\n")}` : "🎯 No themes yet.",
      },
    };
  }

  if (subcommand === "create") {
    if (!tail) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /theme create <label>[: brief]" },
      };
    }
    const colonIndex = tail.indexOf(":");
    const label = colonIndex >= 0 ? tail.slice(0, colonIndex).trim() : tail.trim();
    const brief = colonIndex >= 0 ? tail.slice(colonIndex + 1).trim() : undefined;
    const created = await callGateway<{ theme?: GatewayThemeSummary }>({
      method: "themes.create",
      params: { agentId: params.agentId, label, brief },
      timeoutMs: 10_000,
    });
    if (params.sessionKey) {
      await callGateway({
        method: "sessions.patch",
        params: { key: params.sessionKey, themeId: created?.theme?.id },
        timeoutMs: 10_000,
      });
    }
    return {
      shouldContinue: false,
      reply: {
        text: created?.theme
          ? `🎯 Theme created and bound: ${created.theme.label}`
          : "🎯 Theme created.",
      },
    };
  }

  if (subcommand === "use") {
    if (!tail) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /theme use <lane-id|lane-label>" },
      };
    }
    const lower = tail.toLowerCase();
    if (lower === "off" || lower === "none") {
      if (params.sessionKey) {
        await callGateway({
          method: "sessions.patch",
          params: { key: params.sessionKey, themeId: null },
          timeoutMs: 10_000,
        });
      }
      return {
        shouldContinue: false,
        reply: { text: "🎯 Theme cleared from this session." },
      };
    }
    const resolved = await callGateway<ThemesResolveResponse>({
      method: "themes.resolve",
      params: { agentId: params.agentId, id: tail, label: tail, includeArchived: true },
      timeoutMs: 10_000,
    });
    const theme = resolved?.theme;
    if (!theme || !params.sessionKey) {
      return {
        shouldContinue: false,
        reply: { text: `🎯 Theme not found: ${tail}` },
      };
    }
    await callGateway({
      method: "sessions.patch",
      params: { key: params.sessionKey, themeId: theme.id },
      timeoutMs: 10_000,
    });
    return {
      shouldContinue: false,
      reply: { text: `🎯 Bound this session to ${theme.label}.` },
    };
  }

  if (subcommand === "clear") {
    if (!params.sessionKey) {
      return {
        shouldContinue: false,
        reply: { text: "🎯 No active session to clear." },
      };
    }
    await callGateway({
      method: "sessions.patch",
      params: { key: params.sessionKey, themeId: null },
      timeoutMs: 10_000,
    });
    return {
      shouldContinue: false,
      reply: { text: "🎯 Theme cleared from this session." },
    };
  }

  if (subcommand === "brief") {
    const current = await resolveCurrentTheme(params);
    if (!current) {
      return {
        shouldContinue: false,
        reply: { text: "🎯 No current theme. Use /theme create or /theme use first." },
      };
    }
    await callGateway({
      method: "themes.patch",
      params: {
        agentId: params.agentId,
        id: current.id,
        brief: tail || null,
      },
      timeoutMs: 10_000,
    });
    return {
      shouldContinue: false,
      reply: {
        text: tail
          ? `🎯 Theme brief updated for ${current.label}.`
          : `🎯 Theme brief cleared for ${current.label}.`,
      },
    };
  }

  if (subcommand === "archive") {
    if (!tail) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /theme archive <lane-id|lane-label>" },
      };
    }
    const archived = await callGateway<{ theme?: GatewayThemeSummary }>({
      method: "themes.archive",
      params: { agentId: params.agentId, id: tail, label: tail },
      timeoutMs: 10_000,
    });
    return {
      shouldContinue: false,
      reply: {
        text: archived?.theme ? `🎯 Archived theme ${archived.theme.label}.` : "🎯 Theme archived.",
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: "Usage: /theme list | /theme create <label>[: brief] | /theme use <id|label> | /theme clear | /theme brief <text> | /theme archive <id|label>",
    },
  };
};
