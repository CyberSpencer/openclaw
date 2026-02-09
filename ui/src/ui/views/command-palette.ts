import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";
import { type CommandPaletteAction } from "../command-palette";
import { icons } from "../icons";

function renderShortcut(shortcut?: string) {
  if (!shortcut) return nothing;
  return html`<span class="command-shortcut mono">${shortcut}</span>`;
}

function renderAction(action: CommandPaletteAction, index: number, selectedIndex: number, onRun: () => void) {
  const active = index === selectedIndex;
  return html`
    <button
      class="command-item ${active ? "active" : ""}"
      role="option"
      aria-selected=${active}
      ?disabled=${action.disabled}
      @click=${onRun}
    >
      <div class="command-item__main">
        <div class="command-item__label">
          ${action.active ? html`<span class="command-item__check">${icons.check}</span>` : nothing}
          <span>${action.label}</span>
        </div>
        ${action.detail ? html`<div class="command-item__detail">${action.detail}</div>` : nothing}
      </div>
      <div class="command-item__meta">
        ${renderShortcut(action.shortcut)}
      </div>
    </button>
  `;
}

export function renderCommandPalette(state: AppViewState) {
  if (!state.commandPaletteOpen) return nothing;
  const actions = state.getCommandPaletteActions();
  const selectedIndex = state.commandPaletteIndex;
  const cmdKey = (() => {
    if (typeof navigator === "undefined") return "Ctrl K";
    const platform = navigator.platform || "";
    return /mac|iphone|ipad|ipod/i.test(platform) ? "Cmd K" : "Ctrl K";
  })();

  let lastGroup: string | null = null;
  const rows = actions.map((action, idx) => {
    const groupHeader =
      action.group !== lastGroup
        ? html`<div class="command-group" role="presentation">${action.group}</div>`
        : nothing;
    lastGroup = action.group;
    return html`${groupHeader}${renderAction(action, idx, selectedIndex, () => state.runCommandPaletteAction(action))}`;
  });

  const empty = html`<div class="command-empty">No results.</div>`;

  return html`
    <div
      class="command-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) state.closeCommandPalette();
      }}
    >
      <div class="command-dialog" @click=${(e: MouseEvent) => e.stopPropagation()}>
        <div class="command-header">
          <span class="command-header__icon">${icons.search}</span>
          <input
            id="command-palette-input"
            class="command-input"
            type="text"
            placeholder="Search..."
            autocomplete="off"
            spellcheck="false"
            .value=${state.commandPaletteQuery}
            @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              state.commandPaletteQuery = target.value;
              state.commandPaletteIndex = 0;
            }}
          />
          <span class="command-header__hint mono">Esc</span>
        </div>
        <div class="command-list" role="listbox" aria-label="Commands">
          ${rows.length ? rows : empty}
        </div>
        <div class="command-footer">
          <span>Enter to run, Up/Down to navigate</span>
          <span class="mono">${cmdKey}</span>
        </div>
      </div>
    </div>
  `;
}
