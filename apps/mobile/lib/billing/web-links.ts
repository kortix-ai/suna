/**
 * kortix.com pages the mobile billing screens open. Mobile has no in-app
 * purchase: plan changes, seats, credit top-ups, and invoices happen on web.
 */

import { getFrontendUrl } from '@/api/config';

const frontend = () => getFrontendUrl().replace(/\/$/, '');

/**
 * Web billing for the signed-in user's account (plan, seats, credits,
 * invoices). A signed-out browser goes through `/auth?redirect=` and lands
 * back here (apps/web/src/middleware.ts).
 */
export const getWebBillingUrl = () => `${frontend()}/settings/billing`;

/** Enterprise enquiries. */
export const getWebContactSalesUrl = () => `${frontend()}/contact`;

/** How credits are counted and spent. */
export const getWebCreditsExplainedUrl = () => `${frontend()}/credits-explained`;
