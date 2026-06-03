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
function initDataLayer() {
  if (typeof window !== 'undefined' && !window.dataLayer) {
    window.dataLayer = [];
  }
}

/**
 * Container Load - First data push before GTM loads
 * Provides contextual page information (master_group, content_group, page_type, language)
 * NOTE: No 'event' key - this is initialization data only
 */
interface ContainerLoadData {
  master_group: string;
  content_group: string;
  page_type: string;
  language: string;
}

/**
 * Pages documented for routeChange tracking (from Miro/data dictionary)
 * Only these page types should trigger routeChange events
 */
const TRACKED_PAGE_TYPES = ['home', 'auth', 'plans', 'order_confirm'] as const;
type TrackedPageType = typeof TRACKED_PAGE_TYPES[number];

function getPageContext(pathname: string): ContainerLoadData {
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
  
  // Projects home
  if (pathname === '/projects') {
    return {
      master_group: 'Platform',
      content_group: 'Projects',
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
  
  // Workspace/Threads - NOT tracked for routeChange (internal navigation)
  if (pathname.startsWith('/projects') || pathname.startsWith('/workspace') || pathname.startsWith('/thread')) {
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
function shouldTrackRouteChange(pageType: string): boolean {
  return TRACKED_PAGE_TYPES.includes(pageType as TrackedPageType);
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

interface RouteChangeData {
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
 * Only fires for documented pages: Homepage, Auth, Projects, Plans, Order Confirm
 * Does NOT fire for internal navigation (threads, settings, etc.)
 */
export function trackRouteChange(pathname: string, searchParams?: string) {
  if (typeof window === 'undefined') return;
  
  // Get contextual variables for the current page
  const pageContext = getPageContext(pathname);
  
  // Determine if this is an order confirmation (returning from Stripe checkout)
  const isOrderConfirm = pathname === '/projects' && searchParams?.includes('subscription=activated');
  const effectivePageType = isOrderConfirm ? 'order_confirm' : pageContext.page_type;
  
  // Only track documented pages (Homepage, Auth, Projects, Plans, Order Confirm)
  // Skip internal navigation like threads, settings, etc.
  if (!shouldTrackRouteChange(effectivePageType)) {
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

  // Store current page as previous for next navigation
  storePreviousPage();
  
  // Mark that we've tracked at least one page
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
}
