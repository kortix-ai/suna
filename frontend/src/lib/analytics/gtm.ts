/**
 * Google Tag Manager Analytics Utilities
 * Handles dataLayer pushes for GA4 tracking
 */

// Extend the Window interface to include dataLayer
interface GTMWindow extends Window {
  dataLayer?: object[];
}

declare const window: GTMWindow;

/**
 * Initialize the dataLayer if it doesn't exist
 * GTM automatically creates window.dataLayer, so we just ensure it exists
 */
export function initDataLayer() {
  if (typeof window !== 'undefined' && !window.dataLayer) {
    window.dataLayer = [];
  }
}

/**
 * Container Load - First data push before GTM loads
 * Provides contextual page information (master_group, content_group, page_type, language)
 * NOTE: No 'event' key - this is initialization data only
 */
export interface ContainerLoadData {
  master_group: string;
  content_group: string;
  page_type: string;
  language: string;
}

export function getPageContext(pathname: string): ContainerLoadData {
  // Determine language from document or default to 'en'
  const language = typeof document !== 'undefined' 
    ? document.documentElement.lang || 'en' 
    : 'en';

  // Map pathname to page context
  if (pathname === '/' || pathname === '') {
    return {
      master_group: 'General',
      content_group: 'Other',
      page_type: 'home',
      language,
    };
  }
  
  if (pathname.startsWith('/auth')) {
    return {
      master_group: 'General',
      content_group: 'User',
      page_type: 'auth',
      language,
    };
  }
  
  if (pathname === '/dashboard') {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'home',
      language,
    };
  }
  
  if (pathname.startsWith('/projects') || pathname.startsWith('/thread')) {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'thread',
      language,
    };
  }
  
  if (pathname.startsWith('/settings')) {
    return {
      master_group: 'Platform',
      content_group: 'User',
      page_type: 'settings',
      language,
    };
  }
  
  // Default for other pages
  return {
    master_group: 'General',
    content_group: 'Other',
    page_type: 'other',
    language,
  };
}

export function pushContainerLoad(pathname: string) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const pageContext = getPageContext(pathname);
  
  // Push without 'event' key - this is initialization data
  window.dataLayer?.push(pageContext);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] Container Load pushed:', pageContext);
  }
}

/**
 * Get the current page referrer from sessionStorage or document.referrer
 */
function getPageReferrer(): string {
  if (typeof window === 'undefined') return '';
  
  // Check if we have a stored previous page in sessionStorage
  const previousPage = sessionStorage.getItem('gtm_previous_page');
  
  // If no previous page, use document.referrer (initial load)
  return previousPage || document.referrer || '';
}

/**
 * Store the current page as the previous page for next navigation
 */
function storePreviousPage() {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem('gtm_previous_page', window.location.href);
}

/**
 * Determine if this is the initial page load
 */
function isInitialLoad(): boolean {
  if (typeof window === 'undefined') return false;
  
  // Check if we've tracked a page before
  const hasTrackedBefore = sessionStorage.getItem('gtm_has_tracked');
  return !hasTrackedBefore;
}

/**
 * Mark that we've tracked at least one page
 */
function markAsTracked() {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem('gtm_has_tracked', 'true');
}

export interface RouteChangeData {
  event: 'routeChange';
  page_location: string;
  page_path: string;
  page_title: string;
  page_referrer: string;
  is_initial_load: boolean;
}

/**
 * Push a routeChange event to the dataLayer
 * This tracks SPA navigation for accurate GA4 page views
 */
export function trackRouteChange(pathname: string, searchParams?: string) {
  if (typeof window === 'undefined') return;
  
  // Initialize dataLayer if needed
  initDataLayer();
  
  // Construct the full path with search params
  const fullPath = searchParams ? `${pathname}?${searchParams}` : pathname;
  const pageLocation = `${window.location.origin}${fullPath}`;
  
  // Get page title (or use pathname as fallback)
  const pageTitle = document.title || pathname;
  
  // Get referrer
  const pageReferrer = getPageReferrer();
  
  // Check if initial load
  const initialLoad = isInitialLoad();
  
  // Construct the data object according to data dictionary
  const routeChangeData: RouteChangeData = {
    event: 'routeChange',
    page_location: pageLocation,
    page_path: fullPath,
    page_title: pageTitle,
    page_referrer: pageReferrer,
    is_initial_load: initialLoad,
  };
  
  // Push to dataLayer
  window.dataLayer?.push(routeChangeData);
  
  // Console log for debugging (remove in production if needed)
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] routeChange pushed:', routeChangeData);
  }
  
  // Store current page as previous for next navigation
  storePreviousPage();
  
  // Mark that we've tracked at least one page
  markAsTracked();
}

/**
 * Clear GTM tracking session data
 * Useful for logout or session reset
 */
export function clearGTMSession() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem('gtm_previous_page');
  sessionStorage.removeItem('gtm_has_tracked');
}

// =============================================================================
// AUTH EVENTS - Sign Up & Login Tracking
// =============================================================================

export type AuthMethod = 'Email' | 'Google' | 'Apple' | 'GitHub';

/**
 * Track sign_up event when a user completes registration
 * Priority 1 event
 */
export function trackSignUp(method: AuthMethod) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const signUpEvent = {
    event: 'sign_up',
    method: method,
  };
  
  window.dataLayer?.push(signUpEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] sign_up pushed:', signUpEvent);
  }
}

/**
 * Track login event when a user logs in
 * Priority 3 event
 */
export function trackLogin(method: AuthMethod) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const loginEvent = {
    event: 'login',
    method: method,
  };
  
  window.dataLayer?.push(loginEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] login pushed:', loginEvent);
  }
}

/**
 * Track cta_upgrade event when user clicks upgrade CTA
 * Priority 3 event
 */
export function trackCtaUpgrade() {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const ctaEvent = {
    event: 'cta_upgrade',
  };
  
  window.dataLayer?.push(ctaEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] cta_upgrade pushed:', ctaEvent);
  }
}

/**
 * Track cta_signup event when user clicks signup CTA on homepage
 */
export function trackCtaSignup() {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const ctaEvent = {
    event: 'cta_signup',
  };
  
  window.dataLayer?.push(ctaEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] cta_signup pushed:', ctaEvent);
  }
}

/**
 * Track send_auth_link event when user clicks magic link button
 * Priority 3 event
 */
export function trackSendAuthLink() {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const authLinkEvent = {
    event: 'send_auth_link',
  };
  
  window.dataLayer?.push(authLinkEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] send_auth_link pushed:', authLinkEvent);
  }
}

// =============================================================================
// ECOMMERCE EVENTS - Purchase Tracking
// =============================================================================

export interface PurchaseItem {
  item_id: string;          // e.g., "tier_2_20", "tier_6_50", "free"
  item_name: string;        // e.g., "Plus", "Pro", "Basic"
  coupon?: string;
  discount?: number;
  item_brand: string;       // "Kortix AI"
  item_category: string;    // "Plans"
  item_list_id: string;     // "plans_listing"
  item_list_name: string;   // "Plans Listing"
  price: number;
  quantity: number;
}

export interface PurchaseCustomer {
  name?: string;
  surname?: string;
  email: string;
}

export interface PurchaseData {
  transaction_id: string;
  value: number;
  tax?: number;
  currency: string;
  coupon?: string;
  customer_type: 'new' | 'returning';
  items: PurchaseItem[];
  customer: PurchaseCustomer;
}

/**
 * Push a purchase event to the dataLayer
 * Call this when a user completes a purchase (after checkout success)
 */
export function trackPurchase(data: PurchaseData) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  // Clear previous ecommerce object (GA4 best practice)
  window.dataLayer?.push({ ecommerce: null });
  
  // Push the purchase event
  const purchaseEvent = {
    event: 'purchase',
    ecommerce: {
      item_list_id: 'plans_listing',
      item_list_name: 'Plans Listing',
      transaction_id: data.transaction_id,
      value: data.value,
      tax: data.tax ?? 0,
      currency: data.currency,
      coupon: data.coupon ?? '',
      customer_type: data.customer_type,
      items: data.items.map(item => ({
        item_id: item.item_id,
        item_name: item.item_name,
        coupon: item.coupon ?? '',
        discount: item.discount ?? 0,
        item_brand: item.item_brand,
        item_category: item.item_category,
        item_list_id: item.item_list_id,
        item_list_name: item.item_list_name,
        price: item.price,
        quantity: item.quantity,
      })),
    },
    customer: {
      name: data.customer.name ?? '',
      surname: data.customer.surname ?? '',
      email: data.customer.email,
    },
  };
  
  window.dataLayer?.push(purchaseEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] purchase pushed:', purchaseEvent);
  }
}

/**
 * Store checkout data before redirecting to Stripe
 * This allows us to track the purchase with full data when user returns
 */
export function storeCheckoutData(data: {
  tier_key: string;
  tier_name: string;
  price: number;
  currency: string;
  billing_period: string;
  coupon?: string;
}) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem('gtm_checkout_data', JSON.stringify({
    ...data,
    timestamp: Date.now(),
  }));
}

/**
 * Retrieve stored checkout data after returning from Stripe
 */
export function getStoredCheckoutData(): {
  tier_key: string;
  tier_name: string;
  price: number;
  currency: string;
  billing_period: string;
  coupon?: string;
  timestamp: number;
} | null {
  if (typeof window === 'undefined') return null;
  
  const stored = sessionStorage.getItem('gtm_checkout_data');
  if (!stored) return null;
  
  try {
    const data = JSON.parse(stored);
    // Only use if less than 1 hour old
    if (Date.now() - data.timestamp > 60 * 60 * 1000) {
      sessionStorage.removeItem('gtm_checkout_data');
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Clear stored checkout data after tracking
 */
export function clearCheckoutData() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem('gtm_checkout_data');
}

