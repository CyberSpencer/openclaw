---
summary: "How chats in the Control UI sidebar map to sessions, threads, and subagents"
read_when:
  - You want to understand what a sidebar chat actually is
  - You are using Control UI or WebChat and a thread opened as a separate chat
title: "Chat Sessions"
---

# Chat Sessions

In the Control UI, a sidebar chat is a **session**, not a visible tree of replies.

That one sentence explains most of the UX:

- one sidebar row = one `sessionKey`
- clicking a row switches the active `sessionKey`
- "New chat" creates a brand new `sessionKey`
- the sidebar is grouped by recency, not by parent and child replies

If you need the implementation details behind this, see [/reference/control-ui-chat-threading](/reference/control-ui-chat-threading).

## Quick mental model

There are a few different things people call a "thread":

- **Sidebar chat**
  A saved session shown in the Control UI sidebar.
- **Transport thread or topic**
  A Slack thread, Discord thread, Telegram topic, or similar transport-level thread.
- **Transcript branch**
  Internal message lineage inside the persisted transcript.
- **Subagent session**
  A spawned child session that can appear in the subagent panel and sometimes be opened directly.

The sidebar only shows the first one directly.

## What happens when you click a chat

Selecting a sidebar chat:

- makes that `sessionKey` active
- updates the browser URL to `?session=<sessionKey>`
- restores that chat's draft text
- restores that chat's queued messages and attachments
- restores that chat's paused state
- restores that chat's live run state, including streaming text, model selection, tool cards, and compaction status

Switching chats does not destroy another session's in-flight UI state. The Control UI keeps that state bucketed per session while the page is open.

## What "New chat" does

"New chat" does not branch the current transcript in the sidebar. It creates a new direct session key like:

```text
agent:<agentId>:chat:<uuid>
```

Then the UI resets that session server-side, opens it, and refreshes the sidebar list.

If you want a fresh conversation, this is the main UI path.

## Why the sidebar is flat

The sidebar groups chats by **recency only**:

- Today
- Yesterday
- Last 7 days
- Last 30 days
- Older

It does **not** render parent and child nesting, even when:

- the underlying transcript has branching lineage
- a transport thread became its own session
- a subagent session was spawned from the current chat

That is why a session can be internally related to another session without appearing indented underneath it.

## What state belongs to a session

The Control UI treats these as session-scoped:

- draft text
- queued outbound messages
- pending attachments
- paused state
- active run id
- streaming assistant text
- model-selection status
- tool output cards
- compaction indicator

So if you leave one chat while it is still streaming, then come back, you return to that same session state instead of a blank composer.

## Subagents and the right-side monitoring UX

The orchestration and subagent UI is also scoped to the active session.

For the current chat, the Control UI asks the gateway for `sessions.subagents`, which returns:

- subagents spawned by the current session
- their run status
- their task labels
- related identity like `rootConversationId` and `threadId`
- background coding agents associated with the same requester session

Some of those rows are openable child chats. Some are monitor-only process rows.

## When a transport thread becomes its own chat

Some connectors map a transport-level thread or topic to its own session key behind the scenes.

Examples:

- a Slack channel thread
- a Discord thread
- a Telegram topic or DM topic thread

When that happens, the session key may gain a suffix like `:thread:<id>` or `:topic:<id>`.

From the operator point of view, the important behavior is:

- the thread can appear as a separate sidebar chat
- it can keep its own draft, transcript, and compaction history
- it may start by inheriting context from the parent session once, then continue independently

So "why did this thread open as a separate chat?" usually means the transport thread was mapped to a distinct session key.

## Compaction and sessions

Compaction belongs to the session and persists in that session's transcript history.

The sidebar does not show transcript branches or compaction entries directly. It just shows the session row, derived title, last-message preview, and recency grouping.

See:

- [/concepts/compaction](/concepts/compaction)
- [/reference/session-management-compaction](/reference/session-management-compaction)
