/**
 * Product events that know only the account (Stripe webhooks, trigger fires,
 * sandbox stops). The event goes to the account's earliest owner: the user
 * whose first-touch campaign attributes the revenue. A personal account's id
 * is its owner's user id, which is also the fallback.
 */

import { accountOwnersByJoinDate } from './membership-read';
import { captureProductEvent, type ProductEventInput } from '../shared/product-analytics';

export function captureAccountProductEvent(
  input: Omit<ProductEventInput, 'userId'> & { accountId: string },
): void {
  // Inside a .then, so even a synchronous throw while building the query lands
  // in the .catch: an analytics lookup never fails the caller (a Stripe webhook).
  void Promise.resolve()
    .then(() => accountOwnersByJoinDate([input.accountId]))
    .then((owners) => owners[0]?.userId ?? input.accountId)
    .catch(() => input.accountId)
    .then((userId) => captureProductEvent({ ...input, userId }));
}
