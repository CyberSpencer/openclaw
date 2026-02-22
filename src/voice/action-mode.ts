export type VoiceActionAllowedIntent = "status" | "triage" | "draft" | "schedule";

export type VoiceActionIntent =
  | VoiceActionAllowedIntent
  | "external_send"
  | "confirm"
  | "cancel"
  | "unknown";

export type VoiceActionPolicy = {
  enabled: boolean;
  allowedIntents: Set<VoiceActionAllowedIntent>;
  requireExplicitSendConfirmation: boolean;
  confirmationTtlMs: number;
};

const DEFAULT_ALLOWED_INTENTS: VoiceActionAllowedIntent[] = [
  "status",
  "triage",
  "draft",
  "schedule",
];
const DEFAULT_CONFIRMATION_TTL_MS = 120_000;

const STATUS_RE = /(^|\b)(status|health|uptime|check status|system status)(\b|$)/i;
const TRIAGE_RE = /(^|\b)(triage|prioriti[sz]e|sort inbox|review inbox|quick triage)(\b|$)/i;
const DRAFT_RE = /(^|\b)(draft|compose|write|reply draft|draft response)(\b|$)/i;
const SCHEDULE_RE =
  /(^|\b)(schedule|calendar|meeting|appointment|remind|reminder|plan meeting)(\b|$)/i;
const EXTERNAL_SEND_RE =
  /(^|\b)(send|text|message|email|mail|dm|post|publish|share|notify|announce)(\b|$)/i;
const CONFIRM_RE = /(^|\b)(confirm|yes|approve|do it|go ahead)(\b|$)/i;
const CANCEL_RE = /(^|\b)(cancel|stop|never mind|dont|don't)(\b|$)/i;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeAllowedIntent(value: string): VoiceActionAllowedIntent | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "status" ||
    normalized === "triage" ||
    normalized === "draft" ||
    normalized === "schedule"
  ) {
    return normalized;
  }
  return null;
}

function parseAllowedIntents(raw: string | undefined): Set<VoiceActionAllowedIntent> {
  const values = (raw ?? "")
    .split(",")
    .map((entry) => normalizeAllowedIntent(entry))
    .filter((entry): entry is VoiceActionAllowedIntent => entry !== null);
  if (!values.length) {
    return new Set(DEFAULT_ALLOWED_INTENTS);
  }
  return new Set(values);
}

export function resolveVoiceActionPolicy(env: NodeJS.ProcessEnv = process.env): VoiceActionPolicy {
  return {
    enabled: parseBool(env.OPENCLAW_VOICE_ACTION_MODE_ENABLED, true),
    allowedIntents: parseAllowedIntents(env.OPENCLAW_VOICE_ACTION_ALLOWED_INTENTS),
    requireExplicitSendConfirmation: parseBool(
      env.OPENCLAW_VOICE_ACTION_REQUIRE_CONFIRM_SEND,
      true,
    ),
    confirmationTtlMs: parsePositiveInt(
      env.OPENCLAW_VOICE_ACTION_CONFIRM_TTL_MS,
      DEFAULT_CONFIRMATION_TTL_MS,
    ),
  };
}

export function classifyVoiceActionIntent(text: string): VoiceActionIntent {
  const normalized = text.trim();
  if (!normalized) {
    return "unknown";
  }

  if (isVoiceActionCancelText(normalized)) {
    return "cancel";
  }
  if (isVoiceActionConfirmText(normalized)) {
    return "confirm";
  }
  if (EXTERNAL_SEND_RE.test(normalized)) {
    return "external_send";
  }
  if (STATUS_RE.test(normalized)) {
    return "status";
  }
  if (TRIAGE_RE.test(normalized)) {
    return "triage";
  }
  if (DRAFT_RE.test(normalized)) {
    return "draft";
  }
  if (SCHEDULE_RE.test(normalized)) {
    return "schedule";
  }
  return "unknown";
}

export function isVoiceActionIntentAllowed(
  intent: VoiceActionIntent,
  policy: VoiceActionPolicy,
): intent is VoiceActionAllowedIntent {
  if (intent === "status" || intent === "triage" || intent === "draft" || intent === "schedule") {
    return policy.allowedIntents.has(intent);
  }
  return false;
}

export function formatAllowedVoiceActionIntents(
  policy: VoiceActionPolicy,
): VoiceActionAllowedIntent[] {
  const ordered = DEFAULT_ALLOWED_INTENTS.filter((intent) => policy.allowedIntents.has(intent));
  return ordered;
}

export function isVoiceActionConfirmText(text: string): boolean {
  const normalized = text.trim();
  return CONFIRM_RE.test(normalized) && /(\bsend\b|\bmessage\b|\bemail\b|\bit\b)/i.test(normalized);
}

export function isVoiceActionCancelText(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

export function scaffoldVoiceIntentPrompt(intent: VoiceActionAllowedIntent, text: string): string {
  const trimmed = text.trim();
  switch (intent) {
    case "status":
      return /^\/?status\b/i.test(trimmed) ? trimmed : `Status request: ${trimmed}`;
    case "triage":
      return `Triage mode: prioritize this request and propose safe next steps.\n\n${trimmed}`;
    case "draft":
      return `Draft mode: create a draft only. Do not send externally unless explicitly confirmed.\n\n${trimmed}`;
    case "schedule":
      return `Schedule mode: propose schedule options or a draft plan only. Do not send invites/messages unless explicitly confirmed.\n\n${trimmed}`;
  }
}
