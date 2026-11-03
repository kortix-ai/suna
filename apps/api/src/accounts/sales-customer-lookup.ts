import { billingCustomers, creditAccounts, enterpriseContracts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { userAccountRows } from '../iam/membership-read';
import { db } from '../shared/db';
import { getStripe } from '../shared/stripe';
import { customerStatus, type Evidence } from './sales-customer';

/** Read-only, current evidence. Missing mappings never prove a non-customer. */
export async function lookupSalesCustomer(userId: string): Promise<boolean | null> {
  try {
    const memberships = await userAccountRows(userId);
    const evidence = [];
    for (const { accountId } of memberships) {
      try {
        const contracts = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.accountId, accountId));
        if (contracts.some((contract) => contract.status === 'active' && Number(contract.licenseUsd) > 0 &&
          contract.startsAt && Date.parse(contract.startsAt) <= Date.now() &&
          contract.endsAt && Date.parse(contract.endsAt) > Date.now())) return true;
        const [billing] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
        const customers = await db.select().from(billingCustomers).where(eq(billingCustomers.accountId, accountId));
        const account: Evidence = { complete: !!billing && customers.length > 0, unsupported: !billing || billing.provider !== 'stripe' ||
          !['none', 'expired'].includes(billing.trialStatus ?? '') || contracts.length > 0,
          subscriptions: [] };
        let canonicalSubscriptionSeen = !billing?.stripeSubscriptionId;
        for (const customer of customers) {
          if (customer.provider !== 'stripe' || !customer.id.startsWith('cus_')) {
            account.unsupported = true;
            continue;
          }
          try {
            const subscriptions = await getStripe().subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });
            account.complete &&= !subscriptions.has_more;
            for (const subscription of subscriptions.data) {
              if (subscription.id === billing?.stripeSubscriptionId) canonicalSubscriptionSeen = true;
              const items = subscription.items;
              const amounts = items.data.map((item) => item.price.unit_amount);
              const status = subscription.status === 'active' &&
                (!Number.isFinite(subscription.current_period_end) || subscription.current_period_end * 1000 <= Date.now())
                ? 'unknown' : subscription.status;
              account.subscriptions.push({ status,
                amount: items.has_more || !amounts.length || amounts.some((amount) => amount === null) ? null :
                  amounts.reduce<number>((total, amount) => total + (amount ?? 0), 0) });
            }
          } catch { account.complete = false; }
        }
        account.complete &&= canonicalSubscriptionSeen;
        evidence.push(account);
        if (customerStatus([account]) === true) return true;
      } catch { evidence.push({ complete: false, unsupported: true, subscriptions: [] }); }
    }
    return customerStatus(evidence);
  } catch { return null; }
}

export async function enrichSalesCustomer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload.type !== 'account.signup' || !payload.data || typeof payload.data !== 'object' ||
    !('user_id' in payload.data) || typeof payload.data.user_id !== 'string') return payload;
  const isCustomer = await lookupSalesCustomer(payload.data.user_id);
  return { ...payload, data: { ...payload.data, is_customer: isCustomer } };
}
