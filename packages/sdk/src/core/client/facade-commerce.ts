import * as P from '../rest/projects-client';

export function bindCommerce() {
  const billing = {
    accountState: P.getAccountState,
    accountStateMinimal: P.getAccountStateMinimal,
    transactions: P.listBillingTransactions,
    transactionsSummary: P.getBillingTransactionsSummary,
    creditBreakdown: P.getBillingCreditBreakdown,
    usageHistory: P.getBillingUsageHistory,
    /** Usage rollup (/v1/usage), optionally grouped by model, provider, or day. */
    usageRollup: P.getUsageRollup,
    /** Unified finalized LLM and compute cost by session. */
    sessionCosts: {
      list: P.listSessionCosts,
      get: P.getSessionCostRecord,
    },
    tierConfigurations: P.getBillingTierConfigurations,

    /**
     * @deprecated The API retired these routes. Both reject with
     * `ENDPOINT_RETIRED`. Use `createPerSeatCheckout`. Removed in the next major.
     */
    checkout: {
      createSession: (input: Parameters<typeof P.createCheckoutSession>[0]) =>
        P.createCheckoutSession(input),
      confirmSession: (sessionId: string, accountId?: string) =>
        P.confirmCheckoutSession(sessionId, accountId),
    },

    /** Manage an existing subscription (portal, cancel/reactivate, downgrade). */
    subscription: {
      createPortalSession: (returnUrl: string, accountId?: string) =>
        P.createPortalSession(returnUrl, accountId),
      cancel: (feedback?: string, accountId?: string) => P.cancelSubscription(feedback, accountId),
      reactivate: (accountId?: string) => P.reactivateSubscription(accountId),
      /** @deprecated Rejects with `ENDPOINT_RETIRED`. Use `createPortalSession`. Removed in the next major. */
      scheduleDowngrade: (targetTierKey: string, commitmentType?: string, accountId?: string) =>
        P.scheduleDowngrade(targetTierKey, commitmentType, accountId),
      cancelScheduledChange: (accountId?: string) => P.cancelScheduledChange(accountId),
      prorationPreview: (newPriceId: string, accountId?: string) =>
        P.getProrationPreview(newPriceId, accountId),
    },

    /** One-off credit purchases + recurring auto-topup configuration. */
    credits: {
      purchase: (input: Parameters<typeof P.purchaseCredits>[0]) => P.purchaseCredits(input),
      autoTopupSettings: (accountId?: string) => P.getAutoTopupSettings(accountId),
      configureAutoTopup: (input: Parameters<typeof P.configureAutoTopup>[0]) =>
        P.configureAutoTopup(input),
    },
  };

  /**
   * Account-invite lifecycle reached by invite token alone — accept/decline/
   * describe are called by the invitee (who may not be an account member, or
   * even signed into this account, yet), so they take only `inviteId` and
   * genuinely don't fit account- or project-scoping.
   */
  const sandboxShares = {
    list: P.listSandboxShares,
    create: P.createSandboxShare,
    revoke: P.revokeSandboxShare,
  };

  /** Deployment-wide flag: is the easy-connect (Pipedream) provider configured? Not project-scoped. */
  return { billing, sandboxShares };
}
