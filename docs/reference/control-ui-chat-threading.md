---
summary: "Deep dive: Control UI chat sessions, session keys, live event routing, and overloaded thread semantics"
read_when:
  - You are changing Control UI chat/session behavior
  - You need to explain what "thread" means in the sidebar, transport layer, transcript, and orchestration
title: "Control UI Chat Threading"
---

# Control UI Chat Threading

This document explains the Control UI and WebChat chat model end-to-end.

The confusing part is that "thread" means at least four different things in this codebase:

1. **Sidebar chat session**
   A flat row in the sidebar keyed by `sessionKey`.
2. **Transport thread or topic**
   A Slack thread, Discord thread, Telegram topic, or similar transport-level thread.
3. **Transcript lineage**
   The persisted `parentId` chain or DAG inside a session transcript, plus parent-session branching.
4. **Spawned child session**
   A subagent or child run that can be monitored from a parent chat and sometimes opened directly.

The sidebar shows the first one. The rest are related, but not rendered as a visible tree.

## Session identity fields

These fields solve different identity problems:

- **`sessionKey`**
  The primary routing and UI identity. This is what the sidebar uses and what the URL stores in `?session=<sessionKey>`.
- **`sessionId`**
  The current transcript file identity behind a session key. A reset keeps the `sessionKey` but rotates the `sessionId`.
- **`spawnedBy`**
  The parent session key that spawned a child session, mostly used for subagent lineage and monitoring.
- **`threadId`**
  The transport thread or topic identity. It can be carried in delivery context, session identity checks, subagent rows, and agent events.
- **`rootConversationId`**
  An orchestration scope identifier used to group related child runs and boards. It is not the thing the sidebar keys on.

Practical rule:

- users usually care about `sessionKey`
- transcript storage cares about `sessionId`
- orchestration and transport identity often care about `spawnedBy`, `threadId`, and `rootConversationId`

## Sidebar source of truth

The Control UI sidebar does not inspect transcript files directly.

Instead:

1. the UI calls `sessions.list`
2. the gateway loads the combined `sessions.json` stores
3. `listSessionsFromStore()` filters, sorts, and classifies rows
4. if requested, the gateway reads transcript title fields to derive:
   - `derivedTitle`
   - `lastMessagePreview`

For the chat sidebar specifically, the UI requests:

- `kind: "direct"`
- `includeDerivedTitles: true`
- `includeLastMessage: true`
- optional `includeSubagents`

This is why the sidebar is a flat recent-sessions list. Its source of truth is `sessions.list`, not the transcript tree.

## Active-session flow

Opening a chat session in the UI does a few things together:

1. persist the current session's draft, queue, attachments, and paused state
2. set the new active `sessionKey`
3. restore the target session's draft, queue, attachments, and paused state
4. sync the active run bucket for that session
5. update browser history to `?session=<sessionKey>`
6. switch the active tab to chat

This is handled by `openChatSession()` and `syncUrlWithSessionKey()`.

### "New chat" flow

The Control UI's "New chat" action creates a fresh direct session key:

```text
agent:<agentId>:chat:<uuid>
```

Then it calls `sessions.reset` for that key and opens the result.

This is a new session, not a nested branch inside the current sidebar row.

## Per-session UI state buckets

The Control UI keeps an in-memory run bucket per session key.

Each bucket stores session-scoped live UI state such as:

- `chatRunId`
- `chatModelLoading`
- `chatStream`
- `chatModelSelection`
- `chatTaskPlan`
- `compactionStatus`
- tool stream state and tool cards

That is why switching chats does not blow away another session's in-flight stream or tool panel state while the page remains open.

The bucket is session-scoped UI runtime state only. It is not session-store persistence.

## Live event routing

There are two main real-time flows:

### `chat` events

Gateway `chat` events are keyed by `sessionKey` and represent the high-level run state:

- `loading`
- `delta`
- `final`
- `aborted`
- `error`

The Control UI routes them to the matching session and only applies them to the active chat state when that session is currently open.

### `agent` events

Gateway `agent` events carry richer streams such as:

- `tool`
- `model`
- `orchestration`
- `compaction`
- `lifecycle`
- `fallback`

The UI routes these into the per-session run host identified by `payload.sessionKey`.

That is the core reason model selection, tool output, compaction toasts, and fallback notices stay isolated per session instead of leaking across open chats.

## Sidebar grouping UX

The sidebar groups rows by recency only:

- Today
- Yesterday
- Last 7 days
- Last 30 days
- Older

There is no parent and child nesting in the sidebar UI, even when the underlying sessions are related.

This is intentional and is separate from transcript lineage.

## Threading semantics by layer

### 1. Sidebar chat session

This is the thing users click.

- identity: `sessionKey`
- list source: `sessions.list`
- visible grouping: recency only

### 2. Transport thread or topic

Some connectors resolve transport threads to distinct session keys.

Common shape:

```text
<baseSessionKey>:thread:<id>
```

Telegram topic-style flows may use `:topic:<id>` instead.

This is how a Slack or Discord thread can become its own chat in the sidebar even though the UI itself does not expose a nested tree.

### 3. Transcript lineage

Inside a session transcript, entries form a `parentId` chain or DAG.

Important consequences:

- compaction writes persisted `compaction` entries into that transcript
- branch navigation can write `branch_summary` entries
- transcript lineage is richer than the flat sidebar representation

In other words, the transcript can branch even when the sidebar stays flat.

### 4. Parent-session branching on first thread use

When a new thread or topic session starts with a `ParentSessionKey`, OpenClaw can fork from the parent transcript once so the child starts with inherited context.

This only happens when:

- the parent session exists
- the child has not already been forked
- the parent is not too large for safe inheritance

If the parent exceeds `session.parentForkMaxTokens`, the child thread session starts fresh instead of inheriting a near-overflow transcript.

### 5. Spawned subagent sessions

Subagent sessions are separate child sessions, usually linked by `spawnedBy` and orchestration identity such as `rootConversationId`.

They are not nested into the sidebar tree either. Instead they appear through the orchestration and subagent monitor surfaces.

## Subagent UX and `sessions.subagents`

For the active chat, the Control UI uses `sessions.subagents` as the canonical monitor.

That RPC returns tasks tied to the requester session, including:

- child session key
- label and task text
- run id and run status
- `rootConversationId`
- `threadId`
- background coding agents associated with the same requester session

The subagent panel is therefore session-scoped, not global.

If a child session is openable, the user can jump into it as its own chat session. If it is a background process row, it remains monitor-only.

## Relevant RPCs and contracts

These interfaces are the important ones for chat/session UX:

- `chat.history`
  Hydrates visible chat history for one `sessionKey`.
- `chat.send`
  Starts a run for one `sessionKey` and streams results back via events.
- `chat.steer`
  Sends follow-up steering input to an active run in the same session.
- `chat.abort`
  Aborts the active run for a run id or session.
- `sessions.list`
  Source of truth for sidebar session rows.
- `sessions.subagents`
  Source of truth for the active session's subagent monitor.
- `sessions.reset`
  Rotates a session to a fresh `sessionId`.
- `sessions.delete`
  Removes a session row and usually archives its transcript.
- `sessions.resolve`
  Resolves a session by key, session id, or label, optionally constrained by `threadId` and `rootConversationId`.

And one URL contract matters for browser state:

- `?session=<sessionKey>`

## How this relates to compaction

Compaction is transcript behavior, not sidebar-tree behavior.

The transcript can compact, branch, or inherit from a parent session while the sidebar still just shows one flat row per `sessionKey`.

For compaction internals, persisted fields, hooks, and recovery behavior, see [/reference/session-management-compaction](/reference/session-management-compaction).
