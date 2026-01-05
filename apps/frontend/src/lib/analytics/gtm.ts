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

/**
 * Pages documented for routeChange tracking (from Miro/data dictionary)
 * Only these page types should trigger routeChange events
 */
export const TRACKED_PAGE_TYPES = ['home', 'auth', 'plans', 'order_confirm'] as const;
export type TrackedPageType = typeof TRACKED_PAGE_TYPES[number];

export function getPageContext(pathname: string): ContainerLoadData {
  // Determine language from document or default to 'en'
  const language = typeof document !== 'undefined' 
    ? document.documentElement.lang || 'en' 
    : 'en';

  // Map pathname to page context
  // Homepage
  if (pathname === '/' || pathname === '') {
    return {
      master_group: 'General',
      content_group: 'Other',
      page_type: 'home',
      language,
    };
  }
  
  // Auth pages
  if (pathname.startsWith('/auth')) {
    return {
      master_group: 'General',
      content_group: 'User',
      page_type: 'auth',
      language,
    };
  }
  
  // Dashboard (main dashboard page only)
  if (pathname === '/dashboard') {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'home',
      language,
    };
  }
  
  // Plans/Subscription page
  if (pathname === '/subscription' || pathname.startsWith('/subscription')) {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'plans',
      language,
    };
  }
  
  // Checkout page (Stripe embedded checkout)
  if (pathname === '/checkout' || pathname.startsWith('/checkout')) {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'checkout',
      language,
    };
  }
  
  // Projects/Threads - NOT tracked for routeChange (internal navigation)
  if (pathname.startsWith('/projects') || pathname.startsWith('/thread')) {
    return {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'thread',
      language,
    };
  }
  
  // Settings - NOT tracked for routeChange (internal navigation)
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

/**
 * Check if a page type should trigger routeChange events
 * Only documented pages (Homepage, Auth, Dashboard, Plans, Order Confirm) should be tracked
 */
export function shouldTrackRouteChange(pageType: string): boolean {
  return TRACKED_PAGE_TYPES.includes(pageType as TrackedPageType);
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
  // Contextual variables included when they change during navigation
  master_group: string;
  content_group: string;
  page_type: string;
}

/**
 * Push a routeChange event to the dataLayer
 * This tracks SPA navigation for accurate GA4 page views
 * 
 * Only fires for documented pages: Homepage, Auth, Dashboard, Plans, Order Confirm
 * Does NOT fire for internal navigation (threads, settings, etc.)
 */
export function trackRouteChange(pathname: string, searchParams?: string) {
  if (typeof window === 'undefined') return;
  
  // Get contextual variables for the current page
  const pageContext = getPageContext(pathname);
  
  // Determine if this is an order confirmation (returning from Stripe checkout)
  const isOrderConfirm = pathname === '/dashboard' && searchParams?.includes('subscription=activated');
  const effectivePageType = isOrderConfirm ? 'order_confirm' : pageContext.page_type;
  
  // Only track documented pages (Homepage, Auth, Dashboard, Plans, Order Confirm)
  // Skip internal navigation like threads, settings, etc.
  if (!shouldTrackRouteChange(effectivePageType)) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[GTM] routeChange skipped (not a tracked page):', pathname, effectivePageType);
    }
    return;
  }
  
  // Initialize dataLayer if needed
  initDataLayer();
  
  // Construct the full URL with search params for page_location only
  const fullPath = searchParams ? `${pathname}?${searchParams}` : pathname;
  const pageLocation = `${window.location.origin}${fullPath}`;
  
  // Get page title (or use pathname as fallback)
  const pageTitle = document.title || pathname;
  
  // Get referrer
  const pageReferrer = getPageReferrer();
  
  // Check if initial load
  const initialLoad = isInitialLoad();
  
  // Construct the data object according to data dictionary
  // Note: page_path should NOT include query strings (only page_location does)
  const routeChangeData: RouteChangeData = {
    event: 'routeChange',
    page_location: pageLocation,
    page_path: pathname,
    page_title: pageTitle,
    page_referrer: pageReferrer,
    is_initial_load: initialLoad,
    master_group: pageContext.master_group,
    content_group: pageContext.content_group,
    page_type: effectivePageType,
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

/**
 * Track routeChange for modal views (like Plans modal)
 * Used when a modal opens but URL doesn't change
 */
export function trackRouteChangeForModal(pageType: 'plans' | 'order_confirm') {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  const pageLocation = window.location.href;
  const pathname = window.location.pathname;
  const pageTitle = document.title || pathname;
  const pageReferrer = getPageReferrer();
  const initialLoad = isInitialLoad();
  
  // Get context based on modal type
  const contextMap = {
    plans: {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'plans',
    },
    order_confirm: {
      master_group: 'Platform',
      content_group: 'Dashboard',
      page_type: 'order_confirm',
    },
  };
  
  const context = contextMap[pageType];
  
  const routeChangeData: RouteChangeData = {
    event: 'routeChange',
    page_location: pageLocation,
    page_path: pathname,
    page_title: pageTitle,
    page_referrer: pageReferrer,
    is_initial_load: initialLoad,
    master_group: context.master_group,
    content_group: context.content_group,
    page_type: context.page_type,
  };
  
  window.dataLayer?.push(routeChangeData);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] routeChange (modal) pushed:', routeChangeData);
  }
  
  storePreviousPage();
  markAsTracked();
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
 * 
 * item_id and item_name should match the format used in add_to_cart:
 * - item_id: e.g., "pro_yearly", "plus_monthly"
 * - item_name: e.g., "Pro Yearly", "Plus Monthly"
 * 
 * price = full product price (before discounts)
 * value = actual transaction value (after discounts/coupons)
 * previous_tier = user's tier before checkout (to determine customer_type)
 */
export function storeCheckoutData(data: {
  item_id: string;       // e.g., "pro_yearly" - matches add_to_cart format
  item_name: string;     // e.g., "Pro Yearly" - matches add_to_cart format
  price: number;         // Full product price (before discounts)
  value: number;         // Actual transaction value (after discounts)
  currency: string;
  billing_period: string;
  coupon?: string;
  discount?: number;
  previous_tier?: string; // User's tier before checkout (e.g., "free", "tier_2_20")
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
  item_id: string;
  item_name: string;
  price: number;
  value: number;
  currency: string;
  billing_period: string;
  coupon?: string;
  discount?: number;
  previous_tier?: string;
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

// =============================================================================
// PLANS EVENTS - select_item, view_item, add_to_cart
// =============================================================================

export interface PlanItemData {
  item_id: string;         // e.g., "pro_monthly", "plus_yearly", "ultra_monthly"
  item_name: string;       // e.g., "Pro Monthly", "Plus Yearly", "Ultra"
  coupon?: string;
  discount?: number;
  item_brand: string;      // "Kortix AI"
  item_category: string;   // "Plans"
  item_list_id: string;    // "plans_listing"
  item_list_name: string;  // "Plans Listing"
  price: number;
  quantity: number;
}

/**
 * Track select_item event when user clicks on Plus/Pro/Ultra plan tabs
 * Priority 2 event
 */
export function trackSelectItem(item: PlanItemData) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  // Clear previous ecommerce object (GA4 best practice)
  window.dataLayer?.push({ ecommerce: null });
  
  const selectItemEvent = {
    event: 'select_item',
    ecommerce: {
      item_list_id: 'plans_listing',
      item_list_name: 'Plans Listing',
      items: [{
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
      }],
    },
  };
  
  window.dataLayer?.push(selectItemEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] select_item pushed:', selectItemEvent);
  }
}

/**
 * Track view_item event when modal opens or billing period changes
 * Priority 2 event
 */
export function trackViewItem(item: PlanItemData, currency: string, value: number) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  // Clear previous ecommerce object (GA4 best practice)
  window.dataLayer?.push({ ecommerce: null });
  
  const viewItemEvent = {
    event: 'view_item',
    ecommerce: {
      currency: currency,
      value: value,
      items: [{
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
      }],
    },
  };
  
  window.dataLayer?.push(viewItemEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] view_item pushed:', viewItemEvent);
  }
}

/**
 * Track add_to_cart event when user clicks Upgrade button
 * Priority 2 event
 */
export function trackAddToCart(item: PlanItemData, currency: string, value: number) {
  if (typeof window === 'undefined') return;
  
  initDataLayer();
  
  // Clear previous ecommerce object (GA4 best practice)
  window.dataLayer?.push({ ecommerce: null });
  
  const addToCartEvent = {
    event: 'add_to_cart',
    ecommerce: {
      currency: currency,
      value: value,
      items: [{
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
      }],
    },
  };
  
  window.dataLayer?.push(addToCartEvent);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('[GTM] add_to_cart pushed:', addToCartEvent);
  }
}

