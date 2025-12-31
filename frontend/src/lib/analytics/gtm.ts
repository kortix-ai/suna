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

