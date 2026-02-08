import { config, getToolCost } from '../config';
import type { BillingCheckResult, BillingDeductResult } from '../types';

const TEST_ACCOUNT = 'test_account';

/**
 * Check if account has sufficient credits.
 *
 * For test accounts and development mode, returns true immediately.
 * Otherwise, calls the Python backend billing API.
 */
export async function checkCredits(
  accountId: string,
  minimumRequired: number = 0.01
): Promise<BillingCheckResult> {
  // Skip billing for test account
  if (accountId === TEST_ACCOUNT) {
    console.debug('[KORTIX_BILLING] Test account - skipping credit check');
    return {
      hasCredits: true,
      message: 'Test mode',
      balance: 999999,
    };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    console.debug('[KORTIX_BILLING] Development mode - skipping credit check');
    return {
      hasCredits: true,
      message: 'Development mode',
      balance: 999999,
    };
  }

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
      console.error(`[KORTIX_BILLING] Backend check credits failed: ${response.status}`);
      // Fail open - let operation proceed
      return {
        hasCredits: true,
        message: 'Credit check error',
        balance: null,
      };
    }

    const data = await response.json();
    const balance = data.credits?.balance || 0;

    if (balance < minimumRequired) {
      console.warn(
        `[KORTIX_BILLING] Insufficient credits for ${accountId}: ` +
          `$${balance.toFixed(4)} < $${minimumRequired.toFixed(4)}`
      );
      return {
        hasCredits: false,
        message: `Insufficient credits. Your balance is $${balance.toFixed(2)}. Please add credits to continue.`,
        balance,
      };
    }

    return {
      hasCredits: true,
      message: `Credits available: $${balance.toFixed(2)}`,
      balance,
    };
  } catch (error) {
    console.error(`[KORTIX_BILLING] Error checking credits: ${error}`);
    // Fail open
    return {
      hasCredits: true,
      message: `Credit check error: ${error}`,
      balance: null,
    };
  }
}

/**
 * Deduct credits for a Kortix tool call.
 *
 * For test accounts and development mode, skips deduction.
 * Otherwise, calls the Python backend billing API.
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
    console.debug('[KORTIX_BILLING] Test account - skipping credit deduction');
    return {
      success: true,
      cost: 0,
      newBalance: 999999,
      skipped: true,
      reason: 'test_token',
    };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    console.debug('[KORTIX_BILLING] Development mode - skipping credit deduction');
    return {
      success: true,
      cost: 0,
      newBalance: 999999,
      skipped: true,
      reason: 'development_mode',
    };
  }

  try {
    const cost = getToolCost(toolName, resultCount);

    if (cost <= 0) {
      console.warn(`[KORTIX_BILLING] Zero cost calculated for ${toolName}`);
      return { success: true, cost: 0, newBalance: 0 };
    }

    const deductDescription =
      description ||
      `Kortix ${toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}`;

    console.info(
      `[KORTIX_BILLING] Deducting $${cost.toFixed(4)} for ${toolName} from ${accountId}`
    );

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
          description: deductDescription,
          session_id: sessionId,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[KORTIX_BILLING] Backend deduct credits failed: ${errorText}`);
      return {
        success: false,
        cost: 0,
        newBalance: 0,
        error: errorText,
      };
    }

    const result = await response.json();

    console.info(
      `[KORTIX_BILLING] Successfully deducted $${cost.toFixed(4)} from ${accountId}. ` +
        `New balance: $${result.new_balance?.toFixed(2) || '?'}`
    );

    return {
      success: result.success,
      cost: result.cost || cost,
      newBalance: result.new_balance || 0,
      transactionId: result.transaction_id,
    };
  } catch (error) {
    console.error(`[KORTIX_BILLING] Error deducting credits: ${error}`);
    return {
      success: false,
      cost: 0,
      newBalance: 0,
      error: String(error),
    };
  }
}

/**
 * Deduct credits for LLM usage.
 *
 * For test accounts and development mode, skips deduction.
 * Otherwise, calls the Python backend billing API.
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
    console.debug('[KORTIX_BILLING] Test account - skipping LLM credit deduction');
    return {
      success: true,
      cost: 0,
      newBalance: 999999,
      skipped: true,
      reason: 'test_token',
    };
  }

  // Skip billing in development mode
  if (config.isDevelopment()) {
    console.debug('[KORTIX_BILLING] Development mode - skipping LLM credit deduction');
    return {
      success: true,
      cost: 0,
      newBalance: 999999,
      skipped: true,
      reason: 'development_mode',
    };
  }

  if (calculatedCost <= 0) {
    console.warn(`[KORTIX_BILLING] Zero cost for LLM ${model}`);
    return { success: true, cost: 0, newBalance: 0 };
  }

  try {
    const description = `LLM: ${model} (${inputTokens}/${outputTokens} tokens)`;

    console.info(
      `[KORTIX_BILLING] Deducting $${calculatedCost.toFixed(6)} for LLM ${model} from ${accountId}`
    );

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
          metadata: {
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[KORTIX_BILLING] Backend deduct LLM credits failed: ${errorText}`);
      return {
        success: false,
        cost: 0,
        newBalance: 0,
        error: errorText,
      };
    }

    const result = await response.json();

    console.info(
      `[KORTIX_BILLING] Successfully deducted $${calculatedCost.toFixed(6)} from ${accountId}. ` +
        `New balance: $${result.new_balance?.toFixed(2) || '?'}`
    );

    return {
      success: result.success,
      cost: result.cost || calculatedCost,
      newBalance: result.new_balance || 0,
      transactionId: result.transaction_id,
    };
  } catch (error) {
    console.error(`[KORTIX_BILLING] Error deducting LLM credits: ${error}`);
    return {
      success: false,
      cost: 0,
      newBalance: 0,
      error: String(error),
    };
  }
}
