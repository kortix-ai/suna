/**
 * Checkout & Billing Browser Integration
 * 
 * Handles opening checkout URLs (provided by our backend) in an in-app browser.
 * Our backend handles the actual Stripe integration and returns masked/proxied URLs.
 * 
 * Note: The backend should return kortix.com URLs that wrap/proxy Stripe,
 * not direct stripe.com URLs for compliance.
 */

import * as WebBrowser from 'expo-web-browser';
import {
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type PurchaseCreditsRequest,
} from './api';

// Import the API functions we need
import { API_URL, getAuthHeaders } from '@/api/config';
import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';
import { APP_SCHEME, buildSuccessUrl, buildCancelUrl } from './return-link';
import { getWebBillingUrl } from './web-links';

// ============================================================================
// API Helper
// ============================================================================

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    log.error('❌ API Error:', {
      endpoint,
      status: response.status,
      error,
    });
    throw new Error(error.detail?.message || error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// ============================================================================
// Backend API Functions
// 
// These call our backend, which handles Stripe integration and returns
// checkout URLs (should be kortix.com masked URLs, not direct stripe.com)
// ============================================================================

const checkoutApi = {
  async createCheckoutSession(request: CreateCheckoutSessionRequest): Promise<CreateCheckoutSessionResponse> {
    log.log('🔄 Creating checkout session via backend...');
    const response = await fetchApi<CreateCheckoutSessionResponse>('/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    log.log('✅ Backend returned checkout URLs:', {
      checkout_url: response.checkout_url,
      fe_checkout_url: response.fe_checkout_url,
    });
    return response;
  },
  
  async purchaseCredits(request: PurchaseCreditsRequest): Promise<{ checkout_url: string }> {
    log.log('🔄 Creating credit purchase via backend...');
    const response = await fetchApi<{ checkout_url: string }>('/billing/purchase-credits', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    log.log('✅ Backend returned credit checkout URL:', response.checkout_url);
    return response;
  },
};

// APP_SCHEME + buildSuccessUrl/buildCancelUrl now live in ./return-link (tested).

// ============================================================================
// Browser Functions
// ============================================================================

/**
 * Open checkout URL in in-app browser
 * 
 * The checkout URL is provided by our backend, which should return
 * a kortix.com masked URL (not direct stripe.com for compliance)
 */
async function openCheckoutInBrowser(
  checkoutUrl: string,
  onSuccess?: () => void,
  onCancel?: () => void
): Promise<void> {
  log.log('🌐 Opening checkout in browser:', checkoutUrl);

  try {
    // Open the URL in an in-app browser session
    // This will redirect back to our app via deep link when done
    const result = await WebBrowser.openAuthSessionAsync(
      checkoutUrl,
      APP_SCHEME
    );

    log.log('📱 Browser session result:', result.type);

    if (result.type === 'success') {
      log.log('✅ Checkout completed successfully');
      onSuccess?.();
    } else if (result.type === 'cancel') {
      log.log('❌ Checkout cancelled by user');
      onCancel?.();
    } else {
      log.log('⚠️ Checkout dismissed:', result.type);
      onCancel?.();
    }
  } catch (error) {
    log.error('❌ Error opening checkout:', error);
    throw error;
  }
}

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

// ============================================================================
// Checkout Flow Functions
// 
// These initiate checkout flows by calling our backend to get checkout URLs,
// then opening them in the in-app browser
// ============================================================================

/**
 * Start subscription plan checkout flow
 * 
 * 1. Calls backend /billing/create-checkout-session
 * 2. Backend returns checkout URL or immediate upgrade status
 * 3. If checkout needed, opens URL in browser
 * 4. If immediate upgrade, calls success callback
 */
export async function startPlanCheckout(
  tierKey: string,
  commitmentType: 'monthly' | 'yearly' | 'yearly_commitment' = 'monthly',
  onSuccess?: () => void,
  onCancel?: () => void
): Promise<CreateCheckoutSessionResponse> {
  log.log('💳 Starting plan checkout...', { tierKey, commitmentType });

  try {
    // For Stripe web checkout, map 'yearly_commitment' to 'yearly'
    // The backend expects 'yearly' for Stripe products, not 'yearly_commitment'
    const stripeCommitmentType = commitmentType === 'yearly_commitment' 
      ? 'yearly' 
      : commitmentType;

    const request: CreateCheckoutSessionRequest = {
      tier_key: tierKey,
      success_url: buildSuccessUrl('plan'),
      cancel_url: buildCancelUrl(),
      commitment_type: stripeCommitmentType,
    };
    
    log.log('📤 Sending checkout request:', { 
      tier_key: tierKey, 
      commitment_type: stripeCommitmentType,
      original_commitment_type: commitmentType 
    });

    const response = await checkoutApi.createCheckoutSession(request);

    // Check if we have a checkout URL to open
    const checkoutUrl = response.fe_checkout_url || response.checkout_url || response.url;
    
    if (checkoutUrl) {
      // Backend returned checkout URL - open it in browser
      log.log('🌐 Opening checkout URL:', checkoutUrl);
      await openCheckoutInBrowser(checkoutUrl, onSuccess, onCancel);
    } else if (response.status === 'upgraded' || response.status === 'updated') {
      // Immediate upgrade (no checkout needed - e.g., downgrade or same billing cycle)
      log.log('✅ Plan upgraded immediately (no checkout required)');
      onSuccess?.();
    } else if (response.status === 'downgrade_scheduled' || response.status === 'scheduled') {
      // Downgrade scheduled for end of billing period
      log.log('📅 Plan change scheduled for next billing cycle');
      onSuccess?.();
    } else {
      // No URL and no known status - something went wrong
      throw new Error('Backend did not return a checkout URL or status');
    }

    return response;
  } catch (error) {
    log.error('❌ Plan checkout error:', error);
    throw error;
  }
}

/**
 * Start credit purchase flow
 * 
 * 1. Calls backend /billing/purchase-credits
 * 2. Backend returns checkout URL
 * 3. Opens URL in browser
 */
export async function startCreditPurchase(
  amount: number,
  onSuccess?: () => void,
  onCancel?: () => void
): Promise<void> {
  log.log('💰 Starting credit purchase...', { amount });

  try {
    const request: PurchaseCreditsRequest = {
      amount,
      success_url: buildSuccessUrl('credits'),
      cancel_url: buildCancelUrl(),
    };

    const response = await checkoutApi.purchaseCredits(request);

    if (response.checkout_url) {
      await openCheckoutInBrowser(response.checkout_url, onSuccess, onCancel);
    } else {
      throw new Error('Backend did not return a checkout URL');
    }
  } catch (error) {
    log.error('❌ Credit purchase error:', error);
    throw error;
  }
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

