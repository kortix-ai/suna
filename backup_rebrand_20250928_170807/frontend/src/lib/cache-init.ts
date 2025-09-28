import { FileCache } from '@/hooks/use-cached-file';

/**
 * Initialize cache maintenance routines
 * - Sets up interval to clean expired cache entries
 * - Adds event handlers for visibility and page unload
 */
export function initializeCacheSystem() {
  // Clean up expired cache entries every 5 minutes
  const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  
  // Cache entry expiration
  const DEFAULT_EXPIRATION = 30 * 60 * 1000; // 30 minutes
  
  // Keep track of our interval
  let cleanupInterval: NodeJS.Timeout | null = null;
  
  // Clean up function to remove expired entries and release blob URLs
  const cleanupCache = () => {
    const now = Date.now();
    let blobUrlsToRevoke: string[] = [];
    
    // This is the implementation detail of how we access the Map inside the FileCache
    // We can't modify it directly, but we need to iterate through it for cleanup
    const cache = (FileCache as any).cache;
    
    if (cache && typeof cache.forEach === 'function') {
      const keysToDelete: string[] = [];
      
      cache.forEach((entry: any, key: string) => {
        // Check if the entry has expired
        if (now - entry.timestamp > DEFAULT_EXPIRATION) {
          keysToDelete.push(key);
          
          // If it's a blob URL, add it to our revocation list
          if (entry.type === 'url' && typeof entry.content === 'string' && entry.content.startsWith('blob:')) {
            blobUrlsToRevoke.push(entry.content);
          }
        }
      });
      
      // Delete expired keys
      keysToDelete.forEach(key => {
        FileCache.delete(key);
      });
      
      // Revoke blob URLs
      blobUrlsToRevoke.forEach(url => {
        try {
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error(`Failed to revoke blob URL: ${url}`, err);
        }
      });
    }
  };
  
  // Set up visibility change handler to clean cache when page becomes visible again
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      // User returned to the page, run a cleanup
      cleanupCache();
    }
  };
  
  // Clean all blob URLs before page unload to prevent memory leaks
  const handleBeforeUnload = () => {
    // This is more aggressive as we're about to unload anyway
    const cache = (FileCache as any).cache;
    
    if (cache && typeof cache.forEach === 'function') {
      cache.forEach((entry: any) => {
        if (entry.type === 'url' && typeof entry.content === 'string' && entry.content.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(entry.content);
          } catch (err) {
            // Ignore errors during page unload
          }
        }
      });
    }
  };
  
  // Start the cleanup interval
  const startCleanupInterval = () => {
    // Clear any existing interval first
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
    
    // Set new interval
    cleanupInterval = setInterval(cleanupCache, CLEANUP_INTERVAL);
  };
  
  // Initialize event listeners
  const initEventListeners = () => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
  };
  
  // Remove event listeners
  const removeEventListeners = () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  };
  
  // Initialize the cache system
  startCleanupInterval();
  initEventListeners();
  
  // Return a cleanup function
  return {
    stopCacheSystem: removeEventListeners,
    clearCache: () => {
      // Revoke all blob URLs before clearing
      const cache = (FileCache as any).cache;
      if (cache && typeof cache.forEach === 'function') {
        cache.forEach((entry: any) => {
          if (entry.type === 'url' && typeof entry.content === 'string' && entry.content.startsWith('blob:')) {
            try {
              URL.revokeObjectURL(entry.content);
            } catch (err) {
              console.error('Failed to revoke URL during cache clear', err);
            }
          }
        });
      }
      
      // Clear the cache
      FileCache.clear();
    }
  };
} 