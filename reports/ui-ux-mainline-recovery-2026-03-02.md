# UI/UX Mainline Recovery (2026-03-02)

## Scope

- Repo: `/Users/spencerthomson/clawd/core`
- Phase 1 lane: `codex_spencer/ui-ux-mainline-recovery-20260302`
- Objective: restore coherent custom UI shell (New chat rail, DGX/voice/topbar/theme) on upstream-synced `main` contracts.

## Root Cause Summary

1. Active runtime had been serving a mixed, dirty branch build.
2. Theme control mismatch existed in source:

- render model used `theme-toggle` in [`ui/src/ui/app-render.helpers.ts`](/Users/spencerthomson/clawd/core/ui/src/ui/app-render.helpers.ts)
- style model used `theme-orb`/`topbar-theme-mode` in [`ui/src/styles/components.css`](/Users/spencerthomson/clawd/core/ui/src/styles/components.css)

3. `ci_local.sh fast` cleans `dist/`, which can remove `dist/control-ui` and cause temporary `503 Control UI assets not found` until `pnpm ui:build` is rerun.

## Safety / Forensics

- Tag: `ui-recovery-pre-mainline-20260302-d37eb777d`
- Backup branch: `backup/ui-recovery-pre-mainline-20260302`
- Bundle: `/tmp/core-ui-recovery-pre-20260302-d37eb777d.bundle`
- Dirty quarantine branch: `codex_spencer/ui-coherent-dashboard-v2-recovery-20260302-quarantine-20260302`
- Dirty patch artifact: [`reports/ui-coherent-dirty-quarantine-2026-03-02.patch`](/Users/spencerthomson/clawd/core/reports/ui-coherent-dirty-quarantine-2026-03-02.patch)
- Preflight artifact: [`reports/ui-ux-recovery-preflight-2026-03-02.md`](/Users/spencerthomson/clawd/core/reports/ui-ux-recovery-preflight-2026-03-02.md)

## Changes Applied (Phase 1)

Restored known-good custom lineage (`14db8765e`) for coherent theme/colors/icons and CSP-safe index bootstrap:

- [`ui/index.html`](/Users/spencerthomson/clawd/core/ui/index.html)
- [`ui/public/apple-touch-icon.png`](/Users/spencerthomson/clawd/core/ui/public/apple-touch-icon.png)
- [`ui/public/favicon-32.png`](/Users/spencerthomson/clawd/core/ui/public/favicon-32.png)
- [`ui/src/styles/base.css`](/Users/spencerthomson/clawd/core/ui/src/styles/base.css)
- [`ui/src/styles/chat.css`](/Users/spencerthomson/clawd/core/ui/src/styles/chat.css)
- [`ui/src/styles/chat/grouped.css`](/Users/spencerthomson/clawd/core/ui/src/styles/chat/grouped.css)
- [`ui/src/styles/chat/layout.css`](/Users/spencerthomson/clawd/core/ui/src/styles/chat/layout.css)
- [`ui/src/styles/chat/text.css`](/Users/spencerthomson/clawd/core/ui/src/styles/chat/text.css)
- [`ui/src/styles/chat/tool-cards.css`](/Users/spencerthomson/clawd/core/ui/src/styles/chat/tool-cards.css)
- [`ui/src/styles/components.css`](/Users/spencerthomson/clawd/core/ui/src/styles/components.css)
- [`ui/src/styles/config.css`](/Users/spencerthomson/clawd/core/ui/src/styles/config.css)
- [`ui/src/styles/layout.css`](/Users/spencerthomson/clawd/core/ui/src/styles/layout.css)
- [`ui/src/styles/layout.mobile.css`](/Users/spencerthomson/clawd/core/ui/src/styles/layout.mobile.css)

## Contract Checklist (Preserved)

1. Chat shell contract:

- `renderChatThreadsNav` remains wired in [`ui/src/ui/app-render.ts:344`](/Users/spencerthomson/clawd/core/ui/src/ui/app-render.ts:344)
- `New chat` rail action remains in [`ui/src/ui/views/chat-threads-nav.ts:213`](/Users/spencerthomson/clawd/core/ui/src/ui/views/chat-threads-nav.ts:213)

2. DGX + voice controls:

- DGX topbar action remains in [`ui/src/ui/app-render.ts:322`](/Users/spencerthomson/clawd/core/ui/src/ui/app-render.ts:322)
- voice toggle remains in [`ui/src/ui/app-render.ts:331`](/Users/spencerthomson/clawd/core/ui/src/ui/app-render.ts:331)

3. Theme coherence:

- theme render model is `theme-toggle` in [`ui/src/ui/app-render.helpers.ts:505`](/Users/spencerthomson/clawd/core/ui/src/ui/app-render.helpers.ts:505)
- matching style selectors exist in [`ui/src/styles/components.css:243`](/Users/spencerthomson/clawd/core/ui/src/styles/components.css:243)
- orphan `theme-orb` selectors removed from active stylesheet.

4. CSP compliance:

- inline `<script>` removed from [`ui/index.html`](/Users/spencerthomson/clawd/core/ui/index.html)

## Validation Evidence

### Tests

- Targeted UI contract tests (20/20 pass):
  - `src/ui/gateway.auth-reconnect.test.ts`
  - `src/ui/app-gateway.disconnect-message.test.ts`
  - `src/ui/navigation.browser.test.ts`
  - `src/ui/focus-mode.browser.test.ts`
  - `src/ui/views/chat.browser.test.ts`
  - `src/ui/controllers/voice.spark-conversation.test.ts`
- Full UI suite: `51 files / 363 tests` passed.
- `bash scripts/ci_local.sh fast`: passed.

### Runtime / Build

- `pnpm ui:build` produced:
  - `dist/control-ui/assets/index-BFS13_TN.js`
  - `dist/control-ui/assets/index-Bp2-fPFp.css`
- Live routes:
  - `GET /` => `200`
  - `GET /chat?session=agent:main:main` => `200`
- Control UI root remains `/Users/spencerthomson/clawd/core/dist/control-ui` in `~/.openclaw/openclaw.json`.
- Single listener confirmed on `127.0.0.1:32555`.

### Live Browser Smoke

- Screenshot: [`reports/ui-smoke-2026-03-02.png`](/Users/spencerthomson/clawd/core/reports/ui-smoke-2026-03-02.png)
- Verified in rendered UI:
  - New chat rail visible
  - topbar health/router/dgx pills visible
  - voice toggle visible
  - theme toggle visible
- Console/page errors during smoke: none.

### Bundle-level checks

Built JS contains:

- `New chat` => true
- `chat-nav__new` => true
- `theme-toggle` => true
- `theme-orb` => false
- `voice-toggle-btn` => true

## Divergence Snapshot

- `main...origin/main`: `271/0`
- `main...aii-private/main`: `0/0`

## Notes

- `openclaw daemon status --json` still reports CLI probe token mismatch in this local environment despite config token parity; this does not block UI route serving and is tracked separately from the UI coherence fix.
- Operational rule added to execution sequence: run `pnpm ui:build` after `ci_local.sh fast` before UI route smoke, because `build` clears `dist/`.

## Phase 2 Status (Selective Enhancements)

- Full structural merge of `origin/ui/dashboard-v2` remains intentionally rejected for this cycle.
- Any future uplift is file-by-file only, preserving Phase 1 shell contracts as hard gates.
