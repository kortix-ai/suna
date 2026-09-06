'use client';

/**
 * The plan card — the subscription, at hero scale, with the seat properties
 * that only a per-seat account has.
 *
 * **Why it exists** (Jay, 2026-09-03): "in the plan, you need to show just the
 * team part, team seat". The Plan tab opened on `AccountOverviewTab`, whose
 * subject is the WALLET — available balance, credits, this period's compute
 * and LLM spend, and the concurrency limits — with the plan itself demoted to
 * a two-line right-hand column beside the balance. Every one of those numbers
 * now has its own pane (`settings/tabs/credits-tab.tsx`), so on the Plan tab
 * that card was both a duplicate and a card about the wrong thing.
 *
 * This inverts it: the plan is the subject, and the seat economics — count,
 * price each, monthly total — are the properties under it.
 *
 * **It replaces `SeatManagementCard` on this pane, and only on this pane.**
 * That card states the same three seat figures as a sentence
 * (`3 seats · $25 per teammate, compute included`) plus a right-aligned total.
 * Rendering both would print the seat count three times in two boxes. The card
 * is untouched and still renders on `/accounts/[id]?tab=billing`, which keeps
 * the wallet-first layout — see `billing-tab.tsx`'s `showWallet`.
 *
 * The strip is per-seat ONLY. A flat plan has no seat properties, and its
 * monthly grant is already a meter on the Credits pane, so a strip here would
 * be a second rendering of a number that has a better one elsewhere.
 */

import { cn } from '@/lib/utils';
import type { AccountState } from '@kortix/sdk';

import { describePlanStatus, formatUsd } from './account-overview';

export interface SeatProperty {
  id: 'count' | 'price' | 'total';
  label: string;
  value: string;
}

/**
 * The three facts about a team's seats, or `null` for any account that does
 * not bill per seat.
 *
 * `monthlyTotal` is multiplied here rather than read from the API for the same
 * reason `SeatManagementCard` multiplies it: there is no field for it. Both
 * derive it from the same two numbers, so they cannot disagree.
 */
export function seatProperties(state: AccountState): SeatProperty[] | null {
  const seats = state.seats;
  if (!seats || state.billing_model !== 'per_seat') return null;

  const perSeat = seats.price_per_seat_usd ?? 0;
  const count = seats.count ?? 0;

  return [
    { id: 'count', label: 'Seats', value: String(count) },
    { id: 'price', label: 'Per seat', value: `${formatUsd(perSeat)}/mo` },
    { id: 'total', label: 'Monthly total', value: `${formatUsd(perSeat * count)}/mo` },
  ];
}

export function PlanCard({ state }: { state: AccountState }) {
  const { name, sublabel, detail, isActive, isWindingDown } = describePlanStatus(state);
  const seats = seatProperties(state);

  return (
    <div className="bg-popover rounded-md border">
      {/* Same geometry as the balance card on the Credits pane — label, hero
          line, qualifier, with the status opposite it — so hopping between the
          two sibling panes does not move the eye. `items-center`, for the
          reason that card documents: the left block is taller than the right,
          and top-aligning them reads as a diagonal rather than a row. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs">Current plan</p>
          <p className="text-foreground mt-1.5 truncate text-2xl leading-none font-semibold tracking-tight">
            {name}
          </p>
          {sublabel ? (
            <p className="text-muted-foreground mt-1.5 truncate text-xs">{sublabel}</p>
          ) : null}
        </div>
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {isActive ? (
            // Optical, not geometric: a 6px dot centred on a 20px line box
            // sits a hair high against the x-height of the text beside it.
            <span
              aria-hidden
              className={cn(
                'mt-px size-1.5 shrink-0 rounded-full',
                isWindingDown ? 'bg-kortix-orange' : 'bg-kortix-green',
              )}
            />
          ) : null}
          <span className="text-muted-foreground truncate text-xs leading-5 first-letter:capitalize">
            {detail}
          </span>
        </span>
      </div>

      {seats ? (
        <div className="divide-border grid grid-cols-3 divide-x border-t">
          {seats.map((property) => (
            <div key={property.id} className="min-w-0 px-4 py-3">
              <p className="text-muted-foreground truncate text-xs">{property.label}</p>
              <p className="text-foreground mt-0.5 truncate text-sm font-medium tabular-nums">
                {property.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
