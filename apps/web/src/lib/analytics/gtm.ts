/**
 * Google Tag Manager Analytics Utilities
 * Handles dataLayer pushes for GA4 tracking
 */

// sessionStorage access goes through the never-throwing accessors from
// managed-storage: in storage-disabled in-app WebViews (e.g. the Dola Android
// `wv` browser) `window.sessionStorage` is `null`, so a bare
// `sessionStorage.getItem(...)` throws `TypeError: Cannot read properties of
// null (reading 'getItem')`. This module runs on every route (the root-layout
// RouteChangeTracker), so an unguarded access would crash analytics on the
// marketing site for those browsers.
import { locales } from '@/i18n/catalog.mjs';
import {
  safeSessionGetItem,
  safeSessionSetItem,
} from '@/lib/storage/managed-storage';

// Extend the Window interface to include dataLayer
interface GTMWindow extends Window {
  dataLayer?: object[];
}

declare const window: GTMWindow;

/**
 * Query parameters that may reach GTM. Everything else is dropped from
 * `page_location` and `page_referrer`: auth pages carry the user's email,
 * return URLs and handoff state in the query, and none of it is analytics.
 */
const ANALYTICS_QUERY_ALLOWLIST = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
]);

/** `origin + pathname`, plus only the allowlisted query parameters. Never a hash. */
export function analyticsLocation(origin: string, pathname: string, search?: string): string {
  const params = new URLSearchParams(search ?? '');
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (ANALYTICS_QUERY_ALLOWLIST.has(key)) kept.append(key, value);
  }
  const query = kept.toString();
  return `${origin}${pathname}${query ? `?${query}` : ''}`;
}

/**
 * Pages where no third-party analytics script may load: signed-in app
 * surfaces and pages whose URL carries a capability token. Checked on the
 * path without its locale prefix.
 */
const ANALYTICS_EXCLUDED_PREFIXES = [
  '/projects',
  '/admin',
  '/settings',
  '/connections',
  '/invites',
  '/setup',
  '/new',
  '/secret-intake',
  '/connect',
  '/approve',
  '/share',
  '/slack',
  '/teams',
  '/tunnel',
  '/cli',
  '/oauth',
  '/preview',
  '/github',
];

export function isAnalyticsExcludedPath(pathname: string): boolean {
  const segments = pathname.split('/');
  const withoutLocale =
    segments.length > 1 && (locales as readonly string[]).includes(segments[1]!)
      ? `/${segments.slice(2).join('/')}`
      : pathname;
  return ANALYTICS_EXCLUDED_PREFIXES.some(
    (prefix) => withoutLocale === prefix || withoutLocale.startsWith(`${prefix}/`),
  );
}

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
export type TrackedPageType = (typeof TRACKED_PAGE_TYPES)[number];

export function getPageContext(pathname: string): ContainerLoadData {
  // Determine language from document or default to 'en'
  const language = typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';

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

  // Workspace/Threads - NOT tracked for routeChange (internal navigation)
  if (
    pathname.startsWith('/projects') ||
    pathname.startsWith('/workspace') ||
    pathname.startsWith('/thread')
  ) {
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

/**
 * Get the current page referrer from sessionStorage or document.referrer
 */
function getPageReferrer(): string {
  if (typeof window === 'undefined') return '';

  // Check if we have a stored previous page in sessionStorage
  const previousPage = safeSessionGetItem('gtm_previous_page');

  if (previousPage) return previousPage;

  // Initial load: document.referrer. An own-origin referrer (a full-page
  // redirect such as the auth callback) gets the same query allowlist.
  const referrer = document.referrer || '';
  try {
    const url = new URL(referrer);
    if (url.origin === window.location.origin) {
      return analyticsLocation(url.origin, url.pathname, url.search);
    }
  } catch {
    // Not a URL: pass nothing rather than an unparsed string.
    return '';
  }
  return referrer;
}

/**
 * Store the current page as the previous page for next navigation
 */
function storePreviousPage() {
  if (typeof window === 'undefined') return;
  safeSessionSetItem(
    'gtm_previous_page',
    analyticsLocation(
      window.location.origin,
      window.location.pathname,
      window.location.href.split('?')[1]?.split('#')[0],
    ),
  );
}

/**
 * Determine if this is the initial page load
 */
function isInitialLoad(): boolean {
  if (typeof window === 'undefined') return false;

  // Check if we've tracked a page before
  const hasTrackedBefore = safeSessionGetItem('gtm_has_tracked');
  return !hasTrackedBefore;
}

/**
 * Mark that we've tracked at least one page
 */
function markAsTracked() {
  if (typeof window === 'undefined') return;
  safeSessionSetItem('gtm_has_tracked', 'true');
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
  const isOrderConfirm =
    pathname === '/dashboard' && searchParams?.includes('subscription=activated');
  const effectivePageType = isOrderConfirm ? 'order_confirm' : pageContext.page_type;

  // Only track documented pages (Homepage, Auth, Dashboard, Plans, Order Confirm)
  // Skip internal navigation like threads, settings, etc.
  if (!shouldTrackRouteChange(effectivePageType)) {
    return;
  }

  // Initialize dataLayer if needed
  initDataLayer();

  // page_location keeps only campaign parameters; see ANALYTICS_QUERY_ALLOWLIST.
  const pageLocation = analyticsLocation(window.location.origin, pathname, searchParams);

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
