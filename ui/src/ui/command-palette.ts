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
