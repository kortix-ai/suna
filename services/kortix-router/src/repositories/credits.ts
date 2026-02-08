import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export interface CreditBalance {
  balance: number;
  expiringCredits: number;
  nonExpiringCredits: number;
  dailyCreditsBalance: number;
}

export interface CreditCheckResult {
  hasCredits: boolean;
  balance: number;
  message: string;
}

export interface CreditDeductResult {
  success: boolean;
  amountDeducted?: number;
  newBalance?: number;
  transactionId?: string;
  error?: string;
}

/**
 * Get credit balance for an account.
 * Fast single query - no HTTP call to Python backend.
 */
export async function getCreditBalance(accountId: string): Promise<CreditBalance | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }

  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('credit_accounts')
      .select('balance, expiring_credits, non_expiring_credits, daily_credits_balance')
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
    };
  } catch (err) {
    console.error('getCreditBalance error:', err);
    return null;
  }
}

/**
 * Check if account has sufficient credits.
 */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01
): Promise<CreditCheckResult> {
  const balance = await getCreditBalance(accountId);

  if (!balance) {
    return {
      hasCredits: false,
      balance: 0,
      message: 'No credit account found',
    };
  }

  if (balance.balance < minimumRequired) {
    return {
      hasCredits: false,
      balance: balance.balance,
      message: `Insufficient credits. Balance: $${balance.balance.toFixed(4)}`,
    };
  }

  return {
    hasCredits: true,
    balance: balance.balance,
    message: 'OK',
  };
}

/**
 * Deduct credits atomically using database function.
 * Uses existing atomic_use_credits PostgreSQL function.
 */
export async function deductCredits(
  accountId: string,
  amount: number,
  description: string,
  threadId?: string,
  messageId?: string
): Promise<CreditDeductResult> {
  if (!isSupabaseConfigured()) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const supabase = getSupabase();

    // Call the existing atomic_use_credits function
    const { data, error } = await supabase.rpc('atomic_use_credits', {
      p_account_id: accountId,
      p_amount: amount,
      p_description: description,
      p_thread_id: threadId || null,
      p_message_id: messageId || null,
    });

    if (error) {
      console.error('deductCredits RPC error:', error);
      return { success: false, error: error.message };
    }

    // The function returns JSONB
    const result = data as {
      success: boolean;
      error?: string;
      amount_deducted?: number;
      new_total?: number;
      transaction_id?: string;
    };

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Unknown error',
      };
    }

    return {
      success: true,
      amountDeducted: result.amount_deducted,
      newBalance: result.new_total,
      transactionId: result.transaction_id,
    };
  } catch (err) {
    console.error('deductCredits error:', err);
    return { success: false, error: 'Deduction error' };
  }
}
