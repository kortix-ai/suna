import { jsonbSafeValue } from '../../shared/jsonb-safe';

type ModelSwitchInput =
  | { kind: 'legacy' }
  | { kind: 'invalid'; error: string }
  | { kind: 'switch'; prompt: string; key: string };

/** An old PUT remains a plain model write; a continuation requires a retry key. */
export function parseModelSwitchInput(body: Record<string, unknown>): ModelSwitchInput {
  if (body.prompt === undefined && body.idempotency_key === undefined) return { kind: 'legacy' };
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) {
    return { kind: 'invalid', error: 'prompt must contain 1..32000 characters' };
  }
  if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim() || body.idempotency_key.length > 128) {
    return { kind: 'invalid', error: 'idempotency_key must contain 1..128 characters' };
  }
  return { kind: 'switch', prompt: jsonbSafeValue(body.prompt), key: jsonbSafeValue(body.idempotency_key) };
}
