import type { CommandPaletteAction } from "./command-palette.ts";

export type KeyboardHost = {
  commandPaletteOpen: boolean;
  commandPaletteIndex: number;
  closeCommandPalette: () => void;
  openCommandPalette: () => Promise<void>;
  getCommandPaletteActions: () => CommandPaletteAction[];
  runCommandPaletteAction: (action: CommandPaletteAction) => void;
};

export function handleGlobalKeydown(host: KeyboardHost, event: KeyboardEvent) {
  const isToggle = (event.metaKey || event.ctrlKey) && event.key && event.key.toLowerCase() === "k";
  if (isToggle) {
    event.preventDefault();
    if (host.commandPaletteOpen) {
      host.closeCommandPalette();
    } else {
      void host.openCommandPalette();
    }
    return;
  }

  if (!host.commandPaletteOpen) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    host.closeCommandPalette();
    return;
  }

  const actions = host.getCommandPaletteActions();
  if (!actions.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    host.commandPaletteIndex = (host.commandPaletteIndex + 1) % actions.length;
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    host.commandPaletteIndex = (host.commandPaletteIndex - 1 + actions.length) % actions.length;
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const action = actions[host.commandPaletteIndex];
    if (action) {
      host.runCommandPaletteAction(action);
    }
  }
}
