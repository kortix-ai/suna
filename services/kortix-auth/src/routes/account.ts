import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getCreditBalance } from '../repositories/credits';
import type { AuthVariables } from '../types';

const accountRouter = new Hono<{ Variables: AuthVariables }>();

// All routes require authentication
accountRouter.use('/*', authMiddleware);

/**
 * GET /v1/account - Get account info
 */
accountRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  return c.json({
    success: true,
    data: {
      account_id: userId,
      email: userEmail,
    },
  });
});

/**
 * GET /v1/account/credits - Get credit balance
 */
accountRouter.get('/credits', async (c) => {
  const userId = c.get('userId');

  try {
    const balance = await getCreditBalance(userId);

    if (!balance) {
      return c.json({
        success: true,
        data: {
          balance: 0,
          expiring_credits: 0,
          non_expiring_credits: 0,
          daily_credits_balance: 0,
          tier: 'none',
        },
      });
    }

    return c.json({
      success: true,
      data: {
        balance: balance.balance,
        expiring_credits: balance.expiringCredits,
        non_expiring_credits: balance.nonExpiringCredits,
        daily_credits_balance: balance.dailyCreditsBalance,
        tier: balance.tier,
      },
    });
  } catch (err) {
    console.error('Get credits error:', err);
    return c.json({ success: false, error: 'Failed to get credit balance' }, 500);
  }
});

export { accountRouter };
