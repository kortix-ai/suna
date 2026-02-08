import { config, getToolCost } from '../config';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  checkCredits as checkCreditsDb,
  deductCredits as deductCreditsDb,
} from '../repositories/credits';
import type { BillingCheckResult, BillingDeductResult } from '../types';

const TEST_ACCOUNT = 'test_account';

/**
 * Check if account has sufficient credits.
 *
 * Priority:
 * 1. Test account / dev mode -> skip
 * 2. Supabase configured -> direct DB query (fast)
 * 3. Fallback -> Python backend API (legacy)
 */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01
): Promise<BillingCheckResult> {
  // Skip billing for test account
  if (accountId === TEST_ACCOUNT) {
    return { hasCredits: true, message: 'Test mode', balance: 999999 };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    return { hasCredits: true, message: 'Development mode', balance: 999999 };
  }

  // Direct Supabase (fast path)
  if (isSupabaseConfigured()) {
    const result = await checkCreditsDb(accountId, minimumRequired);
    return {
      hasCredits: result.hasCredits,
      message: result.message,
      balance: result.balance,
    };
  }

  // Legacy: Python backend API
  return checkCreditsLegacy(accountId, minimumRequired);
}

/**
 * Deduct credits for a Kortix tool call.
 *
 * Priority:
 * 1. Test account / dev mode -> skip
 * 2. Supabase configured -> direct DB atomic deduction (fast)
 * 3. Fallback -> Python backend API (legacy)
 */
export async function deductToolCredits(
  accountId: string,
  toolName: string,
  resultCount: number = 0,
  description?: string,
  sessionId?: string
): Promise<BillingDeductResult> {
  // Skip billing for test account
  if (accountId === TEST_ACCOUNT) {
    return { success: true, cost: 0, newBalance: 999999, skipped: true, reason: 'test_token' };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    return { success: true, cost: 0, newBalance: 999999, skipped: true, reason: 'development_mode' };
  }

  const cost = getToolCost(toolName, resultCount);
  if (cost <= 0) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const deductDescription =
    description ||
    `Kortix ${toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}`;

  // Direct Supabase (fast path)
  if (isSupabaseConfigured()) {
    console.info(`[BILLING] Deducting $${cost.toFixed(4)} for ${toolName} (direct DB)`);

    const result = await deductCreditsDb(accountId, cost, deductDescription, sessionId);

    if (!result.success) {
      return { success: false, cost: 0, newBalance: 0, error: result.error };
    }

    console.info(`[BILLING] Deducted $${cost.toFixed(4)}. New balance: $${result.newBalance?.toFixed(2)}`);

    return {
      success: true,
      cost: result.amountDeducted || cost,
      newBalance: result.newBalance || 0,
      transactionId: result.transactionId,
    };
  }

  // Legacy: Python backend API
  return deductToolCreditsLegacy(accountId, toolName, cost, deductDescription, sessionId);
}

/**
 * Deduct credits for LLM usage.
 *
 * Priority:
 * 1. Test account / dev mode -> skip
 * 2. Supabase configured -> direct DB atomic deduction (fast)
 * 3. Fallback -> Python backend API (legacy)
 */
export async function deductLLMCredits(
  accountId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  calculatedCost: number,
  sessionId?: string
): Promise<BillingDeductResult> {
  // Skip billing for test account
  if (accountId === TEST_ACCOUNT) {
    return { success: true, cost: 0, newBalance: 999999, skipped: true, reason: 'test_token' };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    return { success: true, cost: 0, newBalance: 999999, skipped: true, reason: 'development_mode' };
  }

  if (calculatedCost <= 0) {
    return { success: true, cost: 0, newBalance: 0 };
  }

  const description = `LLM: ${model} (${inputTokens}/${outputTokens} tokens)`;

  // Direct Supabase (fast path)
  if (isSupabaseConfigured()) {
    console.info(`[BILLING] Deducting $${calculatedCost.toFixed(6)} for ${model} (direct DB)`);

    const result = await deductCreditsDb(accountId, calculatedCost, description, sessionId);

    if (!result.success) {
      return { success: false, cost: 0, newBalance: 0, error: result.error };
    }

    console.info(`[BILLING] Deducted $${calculatedCost.toFixed(6)}. New balance: $${result.newBalance?.toFixed(2)}`);

    return {
      success: true,
      cost: result.amountDeducted || calculatedCost,
      newBalance: result.newBalance || 0,
      transactionId: result.transactionId,
    };
  }

  // Legacy: Python backend API
  return deductLLMCreditsLegacy(accountId, model, inputTokens, outputTokens, calculatedCost, sessionId);
}

// ============================================================================
// Legacy: Python Backend API (fallback when Supabase not configured)
// ============================================================================

async function checkCreditsLegacy(
  accountId: string,
  minimumRequired: number
): Promise<BillingCheckResult> {
  try {
    const response = await fetch(
      `${config.BACKEND_API_URL}/v1/billing/account-state`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.BACKEND_API_KEY}`,
          'X-Account-ID': accountId,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.error(`[BILLING] Backend check credits failed: ${response.status}`);
      return { hasCredits: true, message: 'Credit check error', balance: null };
    }

    const data = await response.json();
    const balance = data.credits?.balance || 0;

    if (balance < minimumRequired) {
      return {
        hasCredits: false,
        message: `Insufficient credits. Balance: $${balance.toFixed(2)}`,
        balance,
      };
    }

    return { hasCredits: true, message: `Balance: $${balance.toFixed(2)}`, balance };
  } catch (error) {
    console.error(`[BILLING] Error checking credits: ${error}`);
    return { hasCredits: true, message: `Credit check error: ${error}`, balance: null };
  }
}

async function deductToolCreditsLegacy(
  accountId: string,
  toolName: string,
  cost: number,
  description: string,
  sessionId?: string
): Promise<BillingDeductResult> {
  try {
    console.info(`[BILLING] Deducting $${cost.toFixed(4)} for ${toolName} (legacy API)`);

    const response = await fetch(
      `${config.BACKEND_API_URL}/v1/kortix/internal/deduct-credits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.BACKEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_id: accountId,
          amount: cost,
          tool_name: toolName,
          description,
          session_id: sessionId,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BILLING] Backend deduct credits failed: ${errorText}`);
      return { success: false, cost: 0, newBalance: 0, error: errorText };
    }

    const result = await response.json();
    return {
      success: result.success,
      cost: result.cost || cost,
      newBalance: result.new_balance || 0,
      transactionId: result.transaction_id,
    };
  } catch (error) {
    console.error(`[BILLING] Error deducting credits: ${error}`);
    return { success: false, cost: 0, newBalance: 0, error: String(error) };
  }
}

async function deductLLMCreditsLegacy(
  accountId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  calculatedCost: number,
  sessionId?: string
): Promise<BillingDeductResult> {
  try {
    const description = `LLM: ${model} (${inputTokens}/${outputTokens} tokens)`;

    console.info(`[BILLING] Deducting $${calculatedCost.toFixed(6)} for ${model} (legacy API)`);

    const response = await fetch(
      `${config.BACKEND_API_URL}/v1/kortix/internal/deduct-credits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.BACKEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_id: accountId,
          amount: calculatedCost,
          tool_name: 'llm_proxy',
          description,
          session_id: sessionId,
          metadata: { model, input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BILLING] Backend deduct LLM credits failed: ${errorText}`);
      return { success: false, cost: 0, newBalance: 0, error: errorText };
    }

    const result = await response.json();
    return {
      success: result.success,
      cost: result.cost || calculatedCost,
      newBalance: result.new_balance || 0,
      transactionId: result.transaction_id,
    };
  } catch (error) {
    console.error(`[BILLING] Error deducting LLM credits: ${error}`);
    return { success: false, cost: 0, newBalance: 0, error: String(error) };
  }
}
