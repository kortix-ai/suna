import { eq, sql } from 'drizzle-orm';
import { stripeWebhookEventsProcessed } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * Insert-or-skip dedupe marker. Returns `false` when the id was already
 * recorded.
 *
 * Billing webhooks call this only AFTER their handler succeeded (see
 * `processStripeWebhook`). A marker written before the handler runs survives a
 * process death mid-handler, and the provider's retry is then answered
 * "duplicate" and the event is lost.
 */
export async function recordWebhookEvent(eventId: string, eventType: string): Promise<boolean> {
  const inserted = await db
    .insert(stripeWebhookEventsProcessed)
    .values({ eventId, eventType })
    .onConflictDoNothing({ target: stripeWebhookEventsProcessed.eventId })
    .returning({ eventId: stripeWebhookEventsProcessed.eventId });
  return inserted.length > 0;
}

/** True when a handler for this event id already ran to completion. */
export async function isWebhookEventProcessed(eventId: string): Promise<boolean> {
  const rows = await db
    .select({ eventId: stripeWebhookEventsProcessed.eventId })
    .from(stripeWebhookEventsProcessed)
    .where(eq(stripeWebhookEventsProcessed.eventId, eventId))
    .limit(1);
  return rows.length > 0;
}

function accountLockKey(accountId: string): bigint {
  let h = 14695981039346656037n;
  for (const ch of `stripe_account:${accountId}`) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 1099511628211n) & 0x7fffffffffffffffn;
  }
  return h;
}

/** The lock could not be acquired in time. The caller fails; the provider retries. */
export class AccountLockTimeoutError extends Error {
  readonly name = 'AccountLockTimeoutError';
}

/**
 * The slice of a Drizzle database the lock needs. The lock transaction only
 * runs `execute`; the locked body keeps using the shared pool.
 */
export interface AccountLockDatabase {
  transaction<T>(fn: (tx: { execute(query: ReturnType<typeof sql>): Promise<unknown> }) => Promise<T>): Promise<T>;
}

export interface AccountLockOptions {
  database: AccountLockDatabase;
  /**
   * Maximum lock transactions one process holds at a time.
   *
   * Each lock transaction pins one pooled connection for the whole body, and
   * the body issues its own queries on OTHER pooled connections. With no cap,
   * N concurrent bodies for N different accounts pin N connections; when N
   * reaches the pool size every body waits for a connection that only another
   * waiting body can free, and every query in the process stalls. The cap
   * keeps at least `poolMax - maxHolders` connections free for the bodies, so
   * a body always progresses. It must stay below the pool size.
   */
  maxHolders: number;
  /** Maximum wait for a holder slot. */
  acquireTimeoutMs: number;
  /** PostgreSQL `lock_timeout` for the advisory-lock wait itself. */
  lockTimeoutMs: number;
}

/** A counting semaphore whose waiters give up after a deadline. */
function createHolderSlots(max: number) {
  let held = 0;
  const waiters: Array<() => void> = [];
  return {
    get held() {
      return held;
    },
    async acquire(timeoutMs: number): Promise<void> {
      if (held < max) {
        held += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          held += 1;
          resolve();
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(grant);
          if (index >= 0) waiters.splice(index, 1);
          reject(new AccountLockTimeoutError(`account lock: no holder slot free within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(grant);
      });
    },
    release(): void {
      held -= 1;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

/**
 * Build a per-account mutual-exclusion helper backed by a transaction-scoped
 * PostgreSQL advisory lock (`pg_advisory_xact_lock`), so it also excludes
 * other API replicas.
 */
export function createAccountLock(options: AccountLockOptions) {
  const { database, maxHolders, acquireTimeoutMs, lockTimeoutMs } = options;
  if (!Number.isInteger(maxHolders) || maxHolders < 1) {
    throw new Error(`createAccountLock: maxHolders must be a positive integer, got ${maxHolders}`);
  }
  const slots = createHolderSlots(maxHolders);
  const lockTimeout = sql.raw(`'${Math.max(1, Math.floor(lockTimeoutMs))}ms'`);

  async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    await slots.acquire(acquireTimeoutMs);
    try {
      return await database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = ${lockTimeout}`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${accountLockKey(accountId)})`);
        return fn();
      });
    } finally {
      slots.release();
    }
  }

  return { withAccountLock, holders: () => slots.held };
}

/**
 * Two holders out of the default six-connection pool (`DEFAULT_DB_POOL_MAX`).
 * Webhook bodies make Stripe calls and hold the lock for about one second, so
 * two concurrent holders per process is enough throughput; a request that
 * cannot get a slot in 20 s fails with 500 and Stripe redelivers it.
 */
export const ACCOUNT_LOCK_MAX_HOLDERS = 2;
export const ACCOUNT_LOCK_ACQUIRE_TIMEOUT_MS = 20_000;
export const ACCOUNT_LOCK_PG_LOCK_TIMEOUT_MS = 15_000;

const defaultAccountLock = createAccountLock({
  database: {
    transaction: (fn) => db.transaction((tx) => fn(tx)),
  },
  maxHolders: ACCOUNT_LOCK_MAX_HOLDERS,
  acquireTimeoutMs: ACCOUNT_LOCK_ACQUIRE_TIMEOUT_MS,
  lockTimeoutMs: ACCOUNT_LOCK_PG_LOCK_TIMEOUT_MS,
});

export function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return defaultAccountLock.withAccountLock(accountId, fn);
}
