import { HTTPException } from 'hono/http-exception';
import { wallet } from '../../billing/wallet';
import type { ActorContext } from '../actor-context';
import { dollarsToCents, refundActorSpend, reserveActorSpend } from './member-spend';

/** The account, amount and member share a refund needs; both reservation types satisfy it. */
export interface Reservation {
  accountId: string;
  cost: number;
  actor?: ActorContext | null;
  actorReservedCents?: number;
}

/**
 * Reserve the member's share of `cost` against their per-cycle spend cap. When the
 * cap rejects the reservation, refund the account credits the caller already
 * reserved and turn the refusal into a 402. `logPrefix` names the caller in the
 * refund-failure log line.
 */
export async function reserveActorCost(
  actor: ActorContext | null,
  cost: number,
  refundCredits: () => Promise<unknown>,
  logPrefix: string,
): Promise<number> {
  const cents = dollarsToCents(cost);
  if (!actor || cents <= 0) return 0;

  const reserved = await reserveActorSpend(actor.sandboxId, actor.userId, cents);
  if (reserved.success) return reserved.reservedCents;

  await refundCredits().catch((error) => {
    console.error(`[${logPrefix}] Credit refund after member cap failure failed:`, error);
  });
  const cap =
    reserved.capCents === null ? 'configured' : `$${(reserved.capCents / 100).toFixed(2)} / cycle`;
  throw new HTTPException(402, {
    message: `Spending cap reached (${cap}). Ask the instance owner to raise or remove the cap.`,
  });
}

/**
 * Refund a reservation: the reserved account credits under their ledger `kind`,
 * then the member's share of the cycle. No-op for a null reservation or a zero
 * amount.
 */
export async function refundReservation(
  reservation: Reservation | null,
  kind: string,
  description: string,
): Promise<void> {
  if (!reservation) return;
  if (reservation.cost > 0) {
    await wallet.grant({
      accountId: reservation.accountId,
      amount: reservation.cost,
      kind,
      description,
      expiring: false,
      key: null,
    });
  }
  if (reservation.actor && (reservation.actorReservedCents ?? 0) > 0) {
    await refundActorSpend(
      reservation.actor.sandboxId,
      reservation.actor.userId,
      reservation.actorReservedCents ?? 0,
    );
  }
}
