/**
 * Web billing links. Mobile buys through RevenueCat (./unified-checkout); a
 * Stripe subscriber manages billing on the web app.
 */

import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';
import { getWebBillingUrl } from './web-links';

/**
 * Open an external URL (web billing management, the Stripe portal, …) through
 * the app's one link rule (`openLink`, COR-151): a kortix.com link opens in the
 * in-app browser, a third-party one in the system browser. Rejects when the
 * link cannot open.
 */
export async function openExternalUrl(url: string): Promise<void> {
  log.log('🌐 Opening external URL:', url);
  await openLink(url);
}

/**
 * Open web billing portal for advanced management
 * 
 * Opens the web app's billing page in the system browser
 * Used for features not available in mobile (cancel, reactivate, invoices, etc.)
 */
export async function openBillingPortal(returnUrl?: string): Promise<void> {
  log.log('🌐 Opening web billing portal...');

  try {
    // Web billing on kortix.com. `/subscription` has no route in apps/web
    // (it 404'd after sign-in); `/settings/billing` is the billing page.
    await openExternalUrl(getWebBillingUrl());
  } catch (error) {
    log.error('❌ Error opening billing portal:', error);
    throw error;
  }
}

