import { db } from '../../shared/db';
import { providerEvents } from '@kortix/db';

export type ProviderEventInput = {
  provider: string;
  kind: 'provision' | 'migrate';
  outcome: 'ok' | 'error' | 'stopped';
  totalMs?: number | null;
  marks?: Array<Record<string, unknown>>;
  attempts?: number;
  errorClass?: 'capacity' | 'other' | null;
  error?: string | null;
  fromProvider?: string | null;
  sessionId?: string | null;
  accountId?: string | null;
};

/**
 * Fire-and-forget provider telemetry. Append-only; NEVER throws into the caller
 * — analytics must never affect provisioning. Do not await on the hot path.
 * The provision timeline it records is already computed by the caller, so this
 * is just one detached INSERT.
 */
export function recordProviderEvent(e: ProviderEventInput): void {
  void db
    .insert(providerEvents)
    .values({
      provider: e.provider,
      kind: e.kind,
      outcome: e.outcome,
      totalMs: e.totalMs ?? null,
      marks: e.marks ?? [],
      attempts: e.attempts ?? 1,
      errorClass: e.errorClass ?? null,
      error: e.error ? e.error.slice(0, 500) : null,
      fromProvider: e.fromProvider ?? null,
      sessionId: e.sessionId ?? null,
      accountId: e.accountId ?? null,
    })
    .catch((err) => console.warn('[provider-events] insert failed (ignored):', err?.message ?? err));
}
