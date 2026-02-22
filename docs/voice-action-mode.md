---
summary: "Voice Action Mode (Feature 6): constrained intents, confirmation gating, Spark degrade reasons"
read_when:
  - Working on Spark conversational voice mode
  - Debugging voice intent routing / confirmation safety
---

# Voice Action Mode

Voice Action Mode is a constrained pathway for conversational Spark voice turns.

## Intent set (allowlist)

When `voiceActionMode=true` is passed to `voice.processText`, the gateway classifies the utterance
into one of these intents:

- `status`
- `triage`
- `draft`
- `schedule`
- `external_send`
- `confirm` / `cancel`
- `unknown`

Only allowlisted intents (`status`, `triage`, `draft`, `schedule`) are executed directly.
`unknown` is blocked with a safe guidance response.

## External-send confirmation gate

`external_send` requests are blocked until explicit confirmation.

Flow:

1. User asks to send (`send`, `text`, `email`, etc.)
2. Gateway stores pending send request (per `sessionKey`) and responds with:
   - confirmation required
   - explicit prompt (`"confirm send"`)
3. User says `confirm send` → pending request is replayed into normal processing
4. User says `cancel` → pending request is discarded

## Structured timing payload

Voice responses expose structured stage timings in `timings.stages`:

- `captureMs`
- `transcribeMs`
- `routeMs`
- `llmMs`
- `ttsMs`
- `playbackMs` (client-side when available)

Legacy top-level timing fields remain for compatibility.

## Spark degrade reason propagation

`spark.status` now includes `voiceDegradedReason` when voice is unavailable.
The UI surfaces this reason in Spark voice blocked states (conversation start, mic blocking,
and voice bar disabled messaging).

## Operator controls

Environment variables:

- `OPENCLAW_VOICE_ACTION_MODE_ENABLED` (default: `true`)
- `OPENCLAW_VOICE_ACTION_ALLOWED_INTENTS` (CSV subset of `status,triage,draft,schedule`)
- `OPENCLAW_VOICE_ACTION_REQUIRE_CONFIRM_SEND` (default: `true`)
- `OPENCLAW_VOICE_ACTION_CONFIRM_TTL_MS` (default: `120000`)

Client request flags:

- `voice.processText` / `voice.process` support `voiceActionMode: true` to enable constrained mode per request.
