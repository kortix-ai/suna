export const CODEX_AUTH_SECRET_NAME = 'CODEX_AUTH_JSON';

const DEFAULT_CODEX_MODEL_IDS = ['gpt-5.5', 'gpt-5.4'];

export function codexModelIds(): string[] {
  const raw = process.env.KORTIX_CODEX_MODEL_IDS;
  if (!raw) return DEFAULT_CODEX_MODEL_IDS;
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length ? ids : DEFAULT_CODEX_MODEL_IDS;
}
