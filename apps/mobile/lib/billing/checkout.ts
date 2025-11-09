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
import * as Linking from 'expo-linking';
import {
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type PurchaseCreditsRequest,
} from './api';

// Import the API functions we need
import { API_URL, getAuthHeaders } from '@/api/config';

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
    console.error('❌ API Error:', {
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
    console.log('🔄 Creating checkout session via backend...');
    const response = await fetchApi<CreateCheckoutSessionResponse>('/billing/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    console.log('✅ Backend returned checkout URLs:', {
      checkout_url: response.checkout_url,
      fe_checkout_url: response.fe_checkout_url,
    });
    return response;
  },
  
  async purchaseCredits(request: PurchaseCreditsRequest): Promise<{ checkout_url: string }> {
    console.log('🔄 Creating credit purchase via backend...');
    const response = await fetchApi<{ checkout_url: string }>('/billing/purchase-credits', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    console.log('✅ Backend returned credit checkout URL:', response.checkout_url);
    return response;
  },
};

// ============================================================================
// Constants
// ============================================================================

// Deep link scheme for the app (for return URLs after checkout)
const APP_SCHEME = 'agentpress://';
const BILLING_PATH = 'billing';

// ============================================================================
// URL Builders
// ============================================================================

function buildSuccessUrl(context: string = 'checkout'): string {
  return `${APP_SCHEME}${BILLING_PATH}/success?context=${context}`;
}

function buildCancelUrl(): string {
  return `${APP_SCHEME}${BILLING_PATH}/cancel`;
}

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
  console.log('🌐 Opening checkout in browser:', checkoutUrl);

  try {
    // Open the URL in an in-app browser session
    // This will redirect back to our app via deep link when done
    const result = await WebBrowser.openAuthSessionAsync(
      checkoutUrl,
      APP_SCHEME
    );

    console.log('📱 Browser session result:', result.type);

    if (result.type === 'success') {
      console.log('✅ Checkout completed successfully');
      onSuccess?.();
    } else if (result.type === 'cancel') {
      console.log('❌ Checkout cancelled by user');
      onCancel?.();
    } else {
      console.log('⚠️ Checkout dismissed:', result.type);
      onCancel?.();
    }
  } catch (error) {
    console.error('❌ Error opening checkout:', error);
    throw error;
  }
}

/**
 * Open external URL in system browser
 * Used for web billing management, support links, etc.
 */
export async function openExternalUrl(url: string): Promise<void> {
  console.log('🌐 Opening external URL:', url);

  const supported = await Linking.canOpenURL(url);
  
  if (supported) {
    await Linking.openURL(url);
  } else {
    console.error('❌ Cannot open URL:', url);
    throw new Error('Cannot open URL');
  }
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
  console.log('💳 Starting plan checkout...', { tierKey, commitmentType });

  try {
    const request: CreateCheckoutSessionRequest = {
      tier_key: tierKey,
      success_url: buildSuccessUrl('plan'),
      cancel_url: buildCancelUrl(),
      commitment_type: commitmentType,
    };

    const response = await checkoutApi.createCheckoutSession(request);

    // Check if we have a checkout URL to open
    const checkoutUrl = response.fe_checkout_url || response.checkout_url || response.url;
    
    if (checkoutUrl) {
      // Backend returned checkout URL - open it in browser
      console.log('🌐 Opening checkout URL:', checkoutUrl);
      await openCheckoutInBrowser(checkoutUrl, onSuccess, onCancel);
    } else if (response.status === 'upgraded' || response.status === 'updated') {
      // Immediate upgrade (no checkout needed - e.g., downgrade or same billing cycle)
      console.log('✅ Plan upgraded immediately (no checkout required)');
      onSuccess?.();
    } else if (response.status === 'downgrade_scheduled' || response.status === 'scheduled') {
      // Downgrade scheduled for end of billing period
      console.log('📅 Plan change scheduled for next billing cycle');
      onSuccess?.();
    } else {
      // No URL and no known status - something went wrong
      throw new Error('Backend did not return a checkout URL or status');
    }

    return response;
  } catch (error) {
    console.error('❌ Plan checkout error:', error);
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
  console.log('💰 Starting credit purchase...', { amount });

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
    console.error('❌ Credit purchase error:', error);
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
  console.log('🌐 Opening web billing portal...');

  try {
    // Direct users to the web app's billing management page
    const webBillingUrl = process.env.EXPO_PUBLIC_WEB_APP_URL 
      ? `${process.env.EXPO_PUBLIC_WEB_APP_URL}/subscription`
      : 'https://app.kortix.ai/subscription';

    await openExternalUrl(webBillingUrl);
  } catch (error) {
    console.error('❌ Error opening billing portal:', error);
    throw error;
  }
}

