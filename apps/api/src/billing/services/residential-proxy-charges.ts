/**
 * Residential proxy billing: Platinum meters the residential proxy traffic of
 * each box and publishes what it charged in its billing feed,
 * `GET /v1/billing/events?event_type=sandbox.residential_proxy`, oldest first.
 * This tick debits each charge from the wallet of the account that owns the
 * box, at 1× (the pass-through policy of compute,
 * platform/providers/compute-rates.ts).
 *
 * Exactly once per event: the wallet key is `platinum-resi:<event id>`, so a
 * replay (a cursor write that did not land, a leadership flap, two feeds that
 * overlap) moves no money. Each feed's cursor, the `cursor` of the last event
 * processed, is a row in kortix.platform_settings. A failed debit stops its
 * feed before that event; the next tick retries it.
 *
 * Feeds: one per Platinum control plane Kortix creates boxes on. Platinum
 * lists per control plane unless asked to merge (`regions=all`, see
 * listManagedRunningSandboxes in platform/providers/platinum.ts), so a
 * deployment with KORTIX_PLATINUM_US_REGION also reads that region's own
 * control plane, with its own cursor.
 */
import { platformSettings, sessionSandboxes } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { platinumJson, platinumRegionControlPlane } from '../../shared/platinum';
import { platinumUsRegion } from '../../shared/platinum-region';
import type { SettleInput } from '../wallet';
import { settleAndCheckAutoTopup } from './wallet-debits';

export const RESIDENTIAL_PROXY_EVENT_TYPE = 'sandbox.residential_proxy';
export const RESIDENTIAL_PROXY_CURSOR_KEY = 'platinum.residential_proxy.cursor';
const PAGE_LIMIT = 500;
// ponytail: 20 pages (10,000 charges) per feed per tick; a larger backlog drains over the next ticks.
const MAX_PAGES_PER_TICK = 20;

export interface ResidentialProxyChargeEvent {
  id: string;
  /** The Platinum sandbox id: a session box's `session_sandboxes.external_id`. */
  sandbox_id: string;
  /** Bytes through the residential IP. */
  quantity: number;
  /** What Platinum charged, in micro-USD. */
  amount_micros: number;
  /** Resumes the feed right after this event. */
  cursor?: string;
}

export interface ResidentialProxyChargePage {
  events: ResidentialProxyChargeEvent[];
  next_cursor: string | null;
}

/** One control plane's feed: `origin` undefined is PLATINUM_API_URL. */
export interface ResidentialProxyChargeFeed {
  cursorKey: string;
  origin?: string;
}

export interface ResidentialProxyChargeDeps {
  feeds(): ResidentialProxyChargeFeed[];
  /** One page of the feed, or null when this Platinum has no billing feed (404). */
  page(feed: ResidentialProxyChargeFeed, cursor: string | null): Promise<ResidentialProxyChargePage | null>;
  readCursor(key: string): Promise<string | null>;
  writeCursor(key: string, cursor: string): Promise<void>;
  /** The Kortix session box behind a Platinum sandbox id, or null when it is not one of ours. */
  box(platinumSandboxId: string): Promise<{ accountId: string; sessionId: string } | null>;
  settle(input: SettleInput): Promise<unknown>;
}

/** The real collaborators: Platinum over HTTP, the database, the wallet. */
export const residentialProxyChargeDeps: ResidentialProxyChargeDeps = {
  feeds() {
    const region = platinumUsRegion();
    const origin = region ? platinumRegionControlPlane(region) : null;
    return [
      { cursorKey: RESIDENTIAL_PROXY_CURSOR_KEY },
      ...(region && origin ? [{ cursorKey: `${RESIDENTIAL_PROXY_CURSOR_KEY}.${region}`, origin }] : []),
    ];
  },
  async page(feed, cursor) {
    const query = new URLSearchParams({ event_type: RESIDENTIAL_PROXY_EVENT_TYPE, limit: String(PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    try {
      return await platinumJson<ResidentialProxyChargePage>(`/v1/billing/events?${query}`, {}, feed.origin);
    } catch (error) {
      // An older Platinum has no billing feed. Duck-typed: `PlatinumHttpError` carries `status`.
      if (error instanceof Error && (error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  },
  async readCursor(key) {
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, key));
    const cursor = (row?.value as { cursor?: unknown } | undefined)?.cursor;
    return typeof cursor === 'string' && cursor ? cursor : null;
  },
  async writeCursor(key, cursor) {
    await db
      .insert(platformSettings)
      .values({ key, value: { cursor } })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: { cursor }, updatedAt: new Date() } });
  },
  async box(platinumSandboxId) {
    const [row] = await db
      .select({ accountId: sessionSandboxes.accountId, sessionId: sessionSandboxes.sessionId })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.provider, 'platinum'), eq(sessionSandboxes.externalId, platinumSandboxId)))
      .limit(1);
    return row ?? null;
  },
  settle: settleAndCheckAutoTopup,
};

// replica-local: feeds this process already logged as missing (404); a peer logs its own once.
const missingFeedLogged = new Set<string>();

/** Debit every residential proxy charge Platinum published since the last tick. */
export async function syncResidentialProxyCharges(
  deps: ResidentialProxyChargeDeps = residentialProxyChargeDeps,
): Promise<{ debited: number; skipped: number }> {
  const total = { debited: 0, skipped: 0 };
  for (const feed of deps.feeds()) {
    try {
      await syncFeed(feed, deps, total);
    } catch (error) {
      logger.error('[residential-proxy] charge sync failed; the next tick retries', {
        feed: feed.cursorKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}

async function syncFeed(
  feed: ResidentialProxyChargeFeed,
  deps: ResidentialProxyChargeDeps,
  total: { debited: number; skipped: number },
): Promise<void> {
  let saved = await deps.readCursor(feed.cursorKey);
  let request = saved;
  for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages++) {
    const page = await deps.page(feed, request);
    if (!page) {
      if (!missingFeedLogged.has(feed.cursorKey)) {
        missingFeedLogged.add(feed.cursorKey);
        logger.warn('[residential-proxy] this Platinum has no billing feed (404); no residential proxy charge is read', {
          feed: feed.cursorKey,
        });
      }
      return;
    }
    const events = Array.isArray(page.events) ? page.events : [];
    let resume = saved;
    let stopped = false;
    for (const event of events) {
      const outcome = await chargeEvent(event, deps);
      if (outcome === 'failed') {
        stopped = true;
        break;
      }
      total[outcome] += 1;
      resume = event.cursor || resume;
    }
    if (!stopped && page.next_cursor) resume = page.next_cursor;
    if (resume && resume !== saved) {
      await deps.writeCursor(feed.cursorKey, resume);
      saved = resume;
    }
    if (stopped || !page.next_cursor || events.length === 0) return;
    request = page.next_cursor;
  }
}

async function chargeEvent(
  event: ResidentialProxyChargeEvent,
  deps: ResidentialProxyChargeDeps,
): Promise<'debited' | 'skipped' | 'failed'> {
  const fields = { eventId: event.id, platinumSandboxId: event.sandbox_id };
  const amount = Number(event.amount_micros) / 1_000_000;
  if (typeof event.id !== 'string' || !event.id || !Number.isFinite(amount) || amount < 0) {
    logger.error('[residential-proxy] malformed charge skipped', { ...fields, amountMicros: event.amount_micros });
    return 'skipped';
  }
  try {
    const box = await deps.box(event.sandbox_id);
    if (!box) {
      // Another environment's box in the same Platinum org, or a test box.
      logger.info('[residential-proxy] charge for a box this deployment does not own; skipped', fields);
      return 'skipped';
    }
    if (amount === 0) return 'skipped';
    const bytes = Math.max(Number(event.quantity) || 0, 0);
    await deps.settle({
      accountId: box.accountId,
      amount,
      description: `Residential proxy · ${box.sessionId} · ${(bytes / 1_000_000).toFixed(1)} MB`,
      kind: 'proxy_debit',
      key: { request: `platinum-resi:${event.id}` },
      audit: { session_id: box.sessionId, platinum_sandbox_id: event.sandbox_id, platinum_event_id: event.id, bytes },
    });
    return 'debited';
  } catch (error) {
    logger.error('[residential-proxy] debit failed; the feed stops before this charge and the next tick retries it', {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}
