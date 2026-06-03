import { getSupabase } from '../../shared/supabase';
import {
  getCreditAccount,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';

export async function grantCredits(
  accountId: string,
  amount: number,
  type: string,
  description: string,
  isExpiring: boolean = true,
  stripeEventId?: string,
) {
  const supabase = getSupabase();
  const idempotencyKey = stripeEventId ? `grant:${accountId}:${stripeEventId}` : null;

  const { data, error } = await supabase.rpc('atomic_add_credits', {
    p_account_id: accountId,
    p_amount: amount,
    p_is_expiring: isExpiring,
    p_description: description,
    p_expires_at: null,
    p_type: type,
    p_stripe_event_id: stripeEventId ?? null,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error('[Credits] Grant RPC error:', error);

    const account = await getCreditAccount(accountId);
    const currentBalance = account ? Number(account.balance) : 0;
    const newBalance = currentBalance + amount;

    try {
      await insertLedgerEntry({
        accountId,
        amount: String(amount),
        balanceAfter: String(newBalance),
        type,
        description,
        isExpiring,
        stripeEventId: stripeEventId ?? null,
        idempotencyKey,
      });
    } catch (insertErr) {
      const message = insertErr instanceof Error ? insertErr.message : String(insertErr);
      const isDuplicate =
        message.includes('duplicate key') &&
        (message.includes('kortix_unique_stripe_event') || message.includes('idx_kortix_credit_ledger_idempotency'));
      if (isDuplicate) {
        return { success: true, duplicate_prevented: true };
      }

      const missingIdempotencyColumn = message.includes('idempotency_key') && message.includes('does not exist');
      if (missingIdempotencyColumn) {
        await insertLedgerEntry({
          accountId,
          amount: String(amount),
          balanceAfter: String(newBalance),
          type,
          description,
          isExpiring,
          stripeEventId: stripeEventId ?? null,
        });
      } else {
        throw insertErr;
      }
    }

    if (isExpiring) {
      const currentExpiring = account ? Number(account.expiringCredits) : 0;
      await updateCreditAccount(accountId, {
        balance: String(newBalance),
        expiringCredits: String(currentExpiring + amount),
      } as any);
    } else {
      const currentNonExpiring = account ? Number(account.nonExpiringCredits) : 0;
      await updateCreditAccount(accountId, {
        balance: String(newBalance),
        nonExpiringCredits: String(currentNonExpiring + amount),
      } as any);
    }
  }

  return data;
}
