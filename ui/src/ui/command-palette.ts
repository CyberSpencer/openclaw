import type { AppViewState } from "./app-view-state.ts";
import { TAB_GROUPS, subtitleForTab, titleForTab, type Tab } from "./navigation.ts";

export type CommandPaletteAction = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  keywords?: string[];
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

function normalizeQuery(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function actionSearchHaystack(action: CommandPaletteAction): string {
  const parts: string[] = [action.label, action.detail ?? "", action.group];
  if (action.keywords?.length) {
    parts.push(action.keywords.join(" "));
  }
  return normalizeQuery(parts.join(" "));
}

export function filterCommandPaletteActions(
  actions: CommandPaletteAction[],
  query: string,
): CommandPaletteAction[] {
  const q = normalizeQuery(query);
  if (!q) {
    return actions;
  }
  return actions.filter((action) => actionSearchHaystack(action).includes(q));
}

function buildTabActions(state: AppViewState): CommandPaletteAction[] {
  const actions: CommandPaletteAction[] = [];
  for (const group of TAB_GROUPS) {
    for (const tab of group.tabs as readonly Tab[]) {
      const title = titleForTab(tab);
      actions.push({
        id: `tab:${tab}`,
        group: group.label,
        label: title,
        detail: subtitleForTab(tab),
        keywords: [tab, title.toLowerCase(), group.label.toLowerCase()],
        active: state.tab === tab,
        run: () => state.setTab(tab),
      });
    }
  }
  return actions;
}

export function buildCommandPaletteActions(state: AppViewState): CommandPaletteAction[] {
  const actions: CommandPaletteAction[] = [];

  actions.push(...buildTabActions(state));

  actions.push({
    id: "action:refresh",
    group: "Actions",
    label: "Refresh Current View",
    detail: `Reload data for ${titleForTab(state.tab)}.`,
    shortcut: "R",
    disabled: !state.connected,
    run: () => state.setTab(state.tab),
  });

  if (!state.connected) {
    actions.push({
      id: "action:reconnect",
      group: "Actions",
      label: "Reconnect Gateway",
      detail: "Retry connecting to the gateway.",
      shortcut: "C",
      run: () => state.connect(),
    });
  }

  actions.push({
    id: "action:toggle-sidebar",
    group: "Layout",
    label: state.settings.navCollapsed ? "Expand Sidebar" : "Collapse Sidebar",
    detail: "Toggle the left navigation sidebar.",
    shortcut: "B",
    run: () =>
      state.applySettings({
        ...state.settings,
        navCollapsed: !state.settings.navCollapsed,
      }),
  });

  actions.push({
    id: "action:toggle-voice",
    group: "Layout",
    label: state.voiceBarVisible ? "Hide Voice Bar" : "Show Voice Bar",
    detail: "Toggle the voice mode bar.",
    shortcut: "V",
    run: () => state.toggleVoiceBar(),
  });

  actions.push(
    {
      id: "operator:doctor",
      group: "Operator",
      label: "Run Doctor",
      detail: "Run non-interactive gateway diagnostics.",
      keywords: ["health", "diagnostics", "doctor"],
      disabled: !state.connected || state.doctorRunning,
      run: () => state.handleDoctorRun(),
    },
    {
      id: "operator:doctor-deep",
      group: "Operator",
      label: "Doctor (deep)",
      detail: "Run a deeper gateway diagnostics pass.",
      keywords: ["health", "diagnostics", "doctor", "deep"],
      disabled: !state.connected || state.doctorRunning,
      run: () => state.handleDoctorRun({ deep: true }),
    },
    {
      id: "operator:restart-gateway",
      group: "Operator",
      label: "Restart Gateway",
      detail: "Restart the gateway process.",
      keywords: ["restart", "gateway", "reboot"],
      disabled: !state.connected || state.gatewayRestartBusy,
      run: () => {
        const ok = confirm("Restart the gateway now? Connected clients will briefly disconnect.");
        if (!ok) {
          return;
        }
        return state.handleGatewayRestart();
      },
    },
  );

  actions.push(
    {
      id: "config:reload",
      group: "Config",
      label: "Reload Config",
      detail: "Fetch the current gateway config into the editor.",
      keywords: ["config", "reload", "load"],
      disabled: !state.connected || state.configLoading,
      run: () => state.handleConfigLoad(),
    },
    {
      id: "config:save",
      group: "Config",
      label: "Save Config",
      detail: "Write the current config editor contents to disk.",
      keywords: ["config", "save", "write"],
      disabled: !state.connected || state.configSaving,
      run: () => state.handleConfigSave(),
    },
    {
      id: "config:apply",
      group: "Config",
      label: "Apply Config",
      detail: "Save and reload the gateway config immediately.",
      keywords: ["config", "apply", "reload"],
      disabled: !state.connected || state.configApplying,
      run: () => state.handleConfigApply(),
    },
    {
      id: "config:update",
      group: "Config",
      label: state.updateAvailable ? "Update Gateway" : "Check Update Banner",
      detail: state.updateAvailable
        ? `Upgrade to ${state.updateAvailable.latestVersion}.`
        : "Run the gateway update flow when an update is available.",
      keywords: ["update", "upgrade", "gateway"],
      disabled: !state.connected || state.updateRunning || !state.updateAvailable,
      run: () => state.handleRunUpdate(),
    },
  );

  actions.push({
    id: "operator:exec-approvals",
    group: "Operator",
    label: "Exec Approvals",
    detail: "Jump to node exec approvals and allowlists.",
    keywords: ["exec", "approvals", "allowlist", "nodes"],
    run: () => state.setTab("nodes"),
  });

  actions.push(
    {
      id: "theme:system",
      group: "Theme",
      label: "Theme: System",
      active: state.theme === "system",
      run: () => state.setTheme("system"),
    },
    {
      id: "theme:dark",
      group: "Theme",
      label: "Theme: Dark",
      active: state.theme === "dark",
      run: () => state.setTheme("dark"),
    },
    {
      id: "theme:light",
      group: "Theme",
      label: "Theme: Light",
      active: state.theme === "light",
      run: () => state.setTheme("light"),
    },
  );

  return actions;
}
