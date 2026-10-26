'use client';

import type { ShopifyAccess, ShopifyCapability } from '@kortix/sdk';

import { useTranslations } from '../../i18n';
import { StatusDot, type StatusTone } from '../../primitives/status';

/** The four reads the connect checks, in the order a merchant thinks of them. */
const CAPABILITIES = ['catalog', 'orders', 'customers', 'inventory'] as const;

const LABEL = {
  catalog: 'accessCatalog',
  orders: 'accessOrders',
  customers: 'accessCustomers',
  inventory: 'accessInventory',
} as const;

const WORD = {
  ok: 'accessOk',
  blocked: 'accessBlocked',
  missing_scope: 'accessMissingScope',
  error: 'accessError',
} as const;

/** `blocked` and `missing_scope` are app settings a person can change: orange. */
const TONE: Record<ShopifyCapability, StatusTone> = {
  ok: 'success',
  blocked: 'warning',
  missing_scope: 'warning',
  error: 'destructive',
};

/** The access matrix the connect stored on an account (`metadata.shopify.access`), or null. */
export function shopifyAccessOf(metadata: unknown): ShopifyAccess | null {
  const access = (metadata as { shopify?: { access?: unknown } } | null | undefined)?.shopify
    ?.access as ShopifyAccess | undefined;
  return access && typeof access === 'object' && typeof access.catalog === 'string' ? access : null;
}

/** A read the app's settings refuse: fixed in Shopify, then by connecting again. */
export function shopifyAccessNeedsReconnect(access: ShopifyAccess | null): boolean {
  return (
    access !== null &&
    CAPABILITIES.some((key) => access[key] === 'blocked' || access[key] === 'missing_scope')
  );
}

/** What to change in Shopify, one paragraph per refusal kind. */
function AccessHelp({ access }: { access: ShopifyAccess }) {
  const t = useTranslations('connectAppForm');
  const blocked = CAPABILITIES.some((key) => access[key] === 'blocked');
  const missingScope = CAPABILITIES.some((key) => access[key] === 'missing_scope');
  if (!blocked && !missingScope) return null;
  return (
    <div className="text-muted-foreground space-y-1 text-xs text-pretty">
      {blocked ? <p>{t.raw('accessBlockedHelp')}</p> : null}
      {missingScope ? <p>{t.raw('accessMissingScopeHelp')}</p> : null}
    </div>
  );
}

/**
 * The access matrix in full: one row per read, its state as a dot and a word.
 * The connect form shows it once the store is connected.
 */
export function ShopifyAccessList({ access }: { access: ShopifyAccess }) {
  const t = useTranslations('connectAppForm');
  return (
    <div className="space-y-2">
      <p className="text-foreground text-sm font-medium">{t.raw('accessTitle')}</p>
      <ul className="divide-border divide-y rounded-md border">
        {CAPABILITIES.map((key) => (
          <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-foreground text-sm">{t.raw(LABEL[key])}</span>
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <StatusDot tone={TONE[access[key]]} />
              {t.raw(WORD[access[key]])}
            </span>
          </li>
        ))}
      </ul>
      <AccessHelp access={access} />
    </div>
  );
}

/**
 * The access matrix on one account row: each read with its dot. A read that
 * works shows only its name (its state is read aloud); any other names its
 * state, so the dot is never the only carrier.
 */
export function ShopifyAccessInline({ access }: { access: ShopifyAccess }) {
  const t = useTranslations('connectAppForm');
  return (
    <div className="space-y-1">
      <ul
        aria-label={t.raw('accessTitle')}
        className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs"
      >
        {CAPABILITIES.map((key) => (
          <li key={key} className="inline-flex items-center gap-1.5">
            <StatusDot tone={TONE[access[key]]} />
            {access[key] === 'ok' ? (
              <>
                {t.raw(LABEL[key])}
                <span className="sr-only">{` · ${t.raw(WORD.ok)}`}</span>
              </>
            ) : (
              `${t.raw(LABEL[key])} · ${t.raw(WORD[access[key]])}`
            )}
          </li>
        ))}
      </ul>
      <AccessHelp access={access} />
    </div>
  );
}
