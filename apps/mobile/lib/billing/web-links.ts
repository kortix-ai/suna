/**
 * kortix.com pages the mobile billing screens open. Mobile has no in-app
 * purchase: plan changes, seats, credit top-ups, and invoices happen on web.
 */

import { KORTIX_WEB_URL } from '@/lib/kortix-web';

const frontend = () => KORTIX_WEB_URL;

/**
 * Web billing for the signed-in user's account (plan, seats, credits,
 * invoices). A signed-out browser goes through `/auth?redirect=` and lands
 * back here (apps/web/src/middleware.ts).
 */
export const getWebBillingUrl = () => `${frontend()}/settings/billing`;

/** Enterprise enquiries. */
export const getWebContactSalesUrl = () => `${frontend()}/contact`;

/**
 * How credits are counted and spent: the docs page "Credits & usage".
 * `/credits-explained` is its old URL (a 308 to here, apps/web next.config.ts).
 */
export const getWebCreditsExplainedUrl = () => `${frontend()}/docs/credits`;
