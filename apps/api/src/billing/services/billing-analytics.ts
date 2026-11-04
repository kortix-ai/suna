/**
 * Billing events for product analytics. Stripe webhooks know the account, not
 * the person, so the event goes to the account's earliest owner: the user
 * whose first-touch campaign attributes the revenue. A personal account's id
 * is its owner's user id, which is also the fallback.
 */

import { accountOwnersByJoinDate } from '../../iam/membership-read';
import { captureProductEvent, type ProductEventInput } from '../../shared/product-analytics';

export function captureAccountProductEvent(
  input: Omit<ProductEventInput, 'userId'> & { accountId: string },
): void {
  void accountOwnersByJoinDate([input.accountId])
    .then((owners) => owners[0]?.userId ?? input.accountId)
    .catch(() => input.accountId)
    .then((userId) => captureProductEvent({ ...input, userId }));
}
