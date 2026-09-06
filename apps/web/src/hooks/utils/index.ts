/**
 * Utility Hooks
 */
export { useGitHubStars } from './use-github-stars';
export { useLeadingDebouncedCallback } from './use-leading-debounced-callback';
export { useMediaQuery } from './use-media-query';
export { useIsMobile } from './use-mobile';

// Re-export error handling utilities directly from error-handler
export { handleApiError, type ErrorContext } from '@/lib/error-handler';
