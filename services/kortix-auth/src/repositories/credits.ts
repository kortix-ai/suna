import { getSupabase } from '../lib/supabase';

export interface CreditBalance {
  balance: number;
  expiringCredits: number;
  nonExpiringCredits: number;
  dailyCreditsBalance: number;
  tier: string;
}

/**
 * Get credit balance for an account.
 */
export async function getCreditBalance(accountId: string): Promise<CreditBalance | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('credit_accounts')
    .select('balance, expiring_credits, non_expiring_credits, daily_credits_balance, tier')
    .eq('account_id', accountId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    balance: Number(data.balance) || 0,
    expiringCredits: Number(data.expiring_credits) || 0,
    nonExpiringCredits: Number(data.non_expiring_credits) || 0,
    dailyCreditsBalance: Number(data.daily_credits_balance) || 0,
    tier: data.tier || 'none',
  };
}
