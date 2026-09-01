export const CODEX_AUTH_SECRET_NAME = 'CODEX_AUTH_JSON';

// Note: `gpt-5.6-sol` is intentionally NOT served here. The ChatGPT Codex
// subscription rejects it with `400: "The 'gpt-5.6-sol' model is not supported
// when using Codex with a ChatGPT account"` (it is an OpenAI-API-only variant,
// not a ChatGPT-account model). Advertising it under `codex/<id>` caused every
// request for it to fail (14/32 errors over 7d, 0 tokens served) and broke the
// cron triggers pinned to it.
const DEFAULT_CODEX_MODEL_IDS = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
];

export function codexModelIds(): string[] {
  const raw = process.env.KORTIX_CODEX_MODEL_IDS;
  if (!raw) return DEFAULT_CODEX_MODEL_IDS;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? ids : DEFAULT_CODEX_MODEL_IDS;
}
