import { useState, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';

// Global cache to persist between component mounts
const fileCache = new Map<string, {
  content: any; // Could be string content, blob URLs, or other file data
  timestamp: number;
  type: 'content' | 'url' | 'error';
}>();

// Cache expiration time in milliseconds (default: 5 minutes)
const CACHE_EXPIRATION = 5 * 60 * 1000;

// Track in-progress preloads to prevent duplication
const inProgressPreloads = new Map<string, Promise<any>>();

/**
 * Normalize a file path to ensure consistent caching
 * @param path The file path to normalize
 * @returns Normalized path starting with /workspace/
 */
function normalizePath(path: string): string {
  if (!path) return '/workspace';
  
  // Ensure path starts with /workspace
  if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }
  
  // Handle Unicode escape sequences like \u0308
  try {
    path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
      return String.fromCharCode(parseInt(hexCode, 16));
    });
  } catch (e) {
    console.error('Error processing Unicode escapes in path:', e);
  }
  
  return path;
}

/**
 * Generate a consistent cache key for a file
 * @param sandboxId The sandbox ID
 * @param path The file path (will be normalized)
 * @returns A consistent cache key
 */
function getCacheKey(sandboxId: string, path: string): string {
  const normalizedPath = normalizePath(path);
  return `${sandboxId}:${normalizedPath}`;
}

/**
 * Custom hook that fetches and caches file content with authentication support
 * @param sandboxId The sandbox ID to fetch from
 * @param filePath The path to the file
 * @param options Additional options including cache expiration and content type
 * @returns The cached or freshly fetched file content
 */
export function useCachedFile<T = string>(
  sandboxId?: string,
  filePath?: string,
  options: {
    expiration?: number;
    contentType?: 'json' | 'text' | 'blob' | 'arrayBuffer' | 'base64';
    processFn?: (data: any) => T;
  } = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { session } = useAuth();
  const [localBlobUrl, setLocalBlobUrl] = useState<string | null>(null);

  // Calculate cache key from sandbox ID and file path
  const cacheKey = sandboxId && filePath
    ? getCacheKey(sandboxId, filePath)
    : null;

  // Create a cached fetch function
  const getCachedFile = async (key: string, force = false) => {
    // Check if we have a valid cached version
    const cached = fileCache.get(key);
    const now = Date.now();
    const expiration = options.expiration || CACHE_EXPIRATION;
    
    if (!force && cached && now - cached.timestamp < expiration) {
      return cached.content;
    }

    // Fetch fresh content if no cache or expired
    setIsLoading(true);
    try {
      // Use normalized path consistently
      const normalizedPath = normalizePath(filePath || '');
      
      const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
      
      // Properly encode the path parameter for UTF-8 support
      url.searchParams.append('path', normalizedPath);
      
      // Fetch with authentication
      const attemptFetch = async (isRetry: boolean = false): Promise<Response> => {
        const headers: Record<string, string> = {};
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`;
        }
        
        const response = await fetch(url.toString(), {
          headers
        });
        
        if (!response.ok) {
          const responseText = await response.text();
          const errorMessage = `Failed to load file: ${response.status} ${response.statusText}`;
          
          // Check if this is a workspace initialization error and we haven't retried yet
          const isWorkspaceNotRunning = responseText.includes('Workspace is not running');
          if (isWorkspaceNotRunning && !isRetry) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            return attemptFetch(true);
          }
          
          console.error(`[FILE CACHE] Failed response for ${normalizedPath}: Status ${response.status}`);
          throw new Error(errorMessage);
        }
        
        return response;
      };
      
      const response = await attemptFetch();
      
      // Process content based on contentType
      let content;
      let cacheType: 'content' | 'url' | 'error' = 'content';
      
      // Important: Check if this is a binary file that needs special handling
      const isOfficeFile = filePath?.toLowerCase().match(/\.(xlsx|xls|docx|doc|pptx|ppt)$/);
      const isImageFile = filePath ? FileCache.isImageFile(filePath) : false;
      const isPdfFile = filePath ? FileCache.isPdfFile(filePath) : false;
      const isBinaryFile = isOfficeFile || isImageFile || isPdfFile;
      
      // Create a mutable copy of contentType if needed for binary files
      let effectiveContentType = options.contentType || 'text';
      if (isBinaryFile && effectiveContentType !== 'blob') {
        effectiveContentType = 'blob';
      }
      
      switch (effectiveContentType) {
        case 'json':
          content = await response.json();
          break;
        case 'blob':
          // Get the blob
          const blob = await response.blob();
          
          if (isImageFile || isPdfFile) {
            // For images and PDFs, store the raw blob in cache
            
            // Verify the blob is the correct type for PDFs
            if (isPdfFile && !blob.type.includes('pdf') && blob.size > 0) {
              console.warn(`[FILE CACHE] PDF blob has generic MIME type: ${blob.type} - will correct it automatically`);
              
              const firstBytes = await blob.slice(0, 10).text();
              if (firstBytes.startsWith('%PDF')) {
                
                const correctedBlob = new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
                
                // Store the corrected blob in cache and return it
                fileCache.set(key, { content: correctedBlob, timestamp: Date.now(), type: 'content' });
                return correctedBlob;
              }
            }
            
            // Store the raw blob in cache and return it
            fileCache.set(key, { content: blob, timestamp: Date.now(), type: 'content' });
            return blob;
          } else {
            // For other binary files, content is the blob
            content = blob;
            cacheType = 'content';
          }
          break;
        case 'arrayBuffer':
          content = await response.arrayBuffer();
          break;
        case 'base64':
          const buffer = await response.arrayBuffer();
          content = btoa(
            new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
          );
          break;
        case 'text':
        default:
          content = await response.text();
          break;
      }
      
      // After the switch, the caching logic should be simplified to handle all cases that fall through
      fileCache.set(key, {
        content,
        timestamp: now,
        type: cacheType
      });
      
      return content;
    } catch (err: any) {
      // Cache the error to prevent repeated failing requests
      fileCache.set(key, {
        content: null,
        timestamp: Date.now(),
        type: 'error'
      });
      
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Function to get data from cache first, then network if needed
  const getFileContent = async () => {
    if (!cacheKey) return;

    const processContent = (content: any) => {
      if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
      }

      if (content instanceof Blob) {
        const newUrl = URL.createObjectURL(content);
        setLocalBlobUrl(newUrl);
        setData(newUrl as any);
      } else {
        setLocalBlobUrl(null);
        setData(content);
      }
    };
    
    try {
      // First check if we have cached data
      const cachedItem = fileCache.get(cacheKey);
      if (cachedItem) {
        // Set data from cache immediately
        processContent(cachedItem.content);
        
        // If cache is expired, refresh in background
        if (Date.now() - cachedItem.timestamp > (options.expiration || CACHE_EXPIRATION)) {
          getCachedFile(cacheKey, true)
            .then(freshData => processContent(freshData))
            .catch(err => console.error("Background refresh failed:", err));
        }
      } else {
        // No cache, load fresh
        setIsLoading(true);
        const content = await getCachedFile(cacheKey);
        processContent(content);
      }
    } catch (err: any) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (sandboxId && filePath) {
      getFileContent();
    } else {
      // Reset state if we don't have necessary params
      setData(null);
      setIsLoading(false);
      setError(null);
    }
    
    // Clean up the local blob URL when component unmounts
    return () => {
      if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
        setLocalBlobUrl(null);
      }
    };
  }, [sandboxId, filePath, options.contentType]);

  // Expose the cache manipulation functions
  return {
    data,
    isLoading,
    error,
    getCachedFile: (key?: string, force = false) => {
      return key ? getCachedFile(key, force) : (cacheKey ? getCachedFile(cacheKey, force) : Promise.resolve(null));
    },
    // Helper function for direct cache access
    getFromCache: (key: string) => fileCache.get(key)?.content || null,
    // Static version for direct imports
    cache: fileCache
  };
}

// Static functions for direct cache manipulation without hooks
export const FileCache = {
  get: (key: string) => fileCache.get(key)?.content || null,
  
  set: (key: string, content: any) => {
    if (!key || content === null || content === undefined) return;
    
    fileCache.set(key, {
      content,
      timestamp: Date.now(),
      type: typeof content === 'string' && content.startsWith('blob:') ? 'url' : 'content'
    });
  },
  
  has: (key: string) => fileCache.has(key),
  
  clear: () => fileCache.clear(),
  
  delete: (key: string) => fileCache.delete(key),
  
  // Helper function to determine content type from file extension
  getContentTypeFromPath: (path: string): 'text' | 'blob' | 'json' => {
    if (!path) return 'text';
    
    const ext = path.toLowerCase().split('.').pop() || '';
    
    // Binary file extensions
    if (/^(xlsx|xls|docx|pptx|ppt|pdf|png|jpg|jpeg|gif|bmp|webp|svg|ico|zip|exe|dll|bin|dat|obj|o|so|dylib|mp3|mp4|avi|mov|wmv|flv|wav|ogg)$/.test(ext)) {
      return 'blob';
    }
    
    // JSON files
    if (ext === 'json') return 'json';
    
    // Default to text
    return 'text';
  },
  
  // Helper function to check if a file is an image
  isImageFile: (path: string): boolean => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext);
  },
  
  // Helper function to check if a file is a PDF
  isPdfFile: (path: string): boolean => {
    return path.toLowerCase().endsWith('.pdf');
  },
  
  // Helper function to check if a value is a Blob
  isBlob: (value: any): boolean => {
    return value instanceof Blob;
  },
  
  // Helper function to get the correct content type for a file
  getContentType: (path: string, contentType?: 'text' | 'blob' | 'json'): 'text' | 'blob' | 'json' => {
    return contentType || FileCache.getContentTypeFromPath(path);
  },
  
  // Fix: Rename to avoid duplicate property name error
  getMimeTypeFromPath: (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    
    // Office documents
    switch (ext) {
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'xls': return 'application/vnd.ms-excel';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'doc': return 'application/json'; // TipTap document format
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case 'ppt': return 'application/vnd.ms-powerpoint';
      
      // PDF and images
      case 'pdf': return 'application/pdf';
      case 'png': return 'image/png';
      case 'jpg': 
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'svg': return 'image/svg+xml';
      
      // Archives
      case 'zip': return 'application/zip';
      
      // Default
      default: return 'application/octet-stream';
    }
  },
  
  // Preload files into cache for future use
  preload: async (sandboxId: string, filePaths: string[], token?: string | null) => {
    if (!token) {
      // Try to get token from localStorage if not provided
      try {
        const sessionData = localStorage.getItem('auth');
        if (sessionData) {
          const session = JSON.parse(sessionData);
          token = session.access_token;
        }
      } catch (err) {
        console.error('Failed to get auth token from localStorage:', err);
      }
    }
    
    // Skip preloading if no authentication token available
    if (!token) {
      console.warn('Cannot preload files: No authentication token available');
      return [];
    }
    
    // Deduplicate the file paths
    const uniqueFilePaths = [...new Set(filePaths)];

    // Create an array to track promises for each file
    const preloadPromises = uniqueFilePaths.map(async (path) => {
      // Handle Unicode escape sequences in paths
      path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
        return String.fromCharCode(parseInt(hexCode, 16));
      });
      
      const normalizedPath = normalizePath(path);
      const key = getCacheKey(sandboxId, normalizedPath);
      
      // Skip if already cached
      if (fileCache.has(key)) {
        return fileCache.get(key)?.content;
      }
      
      // Check if this file is already being preloaded
      const preloadKey = `${sandboxId}:${normalizedPath}`;
      if (inProgressPreloads.has(preloadKey)) {
        return inProgressPreloads.get(preloadKey);
      }
      
      // Create a promise for this preload and store it
      const preloadPromise = (async () => {
        try {        
          const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
          
          // Properly encode the path parameter for UTF-8 support
          url.searchParams.append('path', normalizedPath);
          
          const attemptFetch = async (isRetry: boolean = false): Promise<Response> => {
            const response = await fetch(url.toString(), {
              headers: {
                'Authorization': `Bearer ${token}`
              },
            });
            
            if (!response.ok) {
              const responseText = await response.text();
              const errorMessage = `Failed to preload file: ${response.status}`;
              
              // Check if this is a workspace initialization error and we haven't retried yet
              const isWorkspaceNotRunning = responseText.includes('Workspace is not running');
              if (isWorkspaceNotRunning && !isRetry) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return attemptFetch(true);
              }
              
              throw new Error(errorMessage);
            }
            
            return response;
          };
          
          const response = await attemptFetch();
          
          // Determine how to process the content based on file type
          const extension = path.split('.').pop()?.toLowerCase();
          let content;
          let type: 'content' | 'url' = 'content';
          
          // Check if this is a binary file (includes Office documents, PDFs, images)
          const isBinaryFile = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'mp3', 'mp4', 
                               'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 
                               'zip', 'exe', 'bin'].includes(extension || '');
          
          if (isBinaryFile) {
            const blob = await response.blob();
            
            if (FileCache.isImageFile(path)) {
              // For images, store the raw blob
              content = blob;
              type = 'content';
            } else if (extension === 'pdf' || ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'].includes(extension || '')) {
              // For PDFs and Office documents, ensure they're stored as blobs with proper MIME type
              const mimeType = FileCache.getMimeTypeFromPath(path);
              const properBlob = new Blob([blob], { type: mimeType });
              content = properBlob;
              type = 'content';
            } else {
              // For other binary files, store the URL
              content = URL.createObjectURL(blob);
              type = 'url';
            }
          } 
          // Json files
          else if (extension === 'json') {
            content = await response.json();
          } 
          // Default to text
          else {
            content = await response.text();
          }
          
          fileCache.set(key, {
            content,
            timestamp: Date.now(),
            type
          });
          
          return content;
        } catch (err) {
          fileCache.set(key, {
            content: null,
            timestamp: Date.now(),
            type: 'error'
          });
          return null;
        } finally {
          // Remove from in-progress map when done
          inProgressPreloads.delete(preloadKey);
        }
      })();
      
      // Store the promise in the in-progress map
      inProgressPreloads.set(preloadKey, preloadPromise);
      
      return preloadPromise;
    });
    
    return Promise.all(preloadPromises);
  },
  
  // Helper function to get the correct MIME type for a file
  getMimeType: (path: string): string => {
    // Call our renamed function to avoid duplication
    return FileCache.getMimeTypeFromPath(path);
  },
};

// Update the getCachedFile function to be simpler and more direct
export async function getCachedFile(
  sandboxId: string,
  filePath: string,
  options: {
    contentType?: 'json' | 'text' | 'blob';
    force?: boolean;
    token?: string;
  } = {}
): Promise<any> {
  if (!filePath || !sandboxId) return null;
  
  // Normalize path and create cache key
  const normalizedPath = normalizePath(filePath);
  const key = getCacheKey(sandboxId, normalizedPath);
  
  // Determine appropriate content type
  const isBinaryFile = FileCache.getContentTypeFromPath(filePath) === 'blob';
  const effectiveType = isBinaryFile ? 'blob' : (options.contentType || 'text');
  
  // Check cache first unless force refresh requested
  if (!options.force && fileCache.has(key)) {
    const cached = fileCache.get(key);
    if (cached && cached.type !== 'error') return cached.content;
  }
  
  // Fetch fresh content
  try {
    const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
    url.searchParams.append('path', normalizedPath);
    
    const attemptFetch = async (isRetry: boolean = false): Promise<Response> => {
      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${options.token}`
        }
      });
      
      if (!response.ok) {
        const responseText = await response.text();
        const errorMessage = `Failed to load file: ${response.status} ${response.statusText}`;
        
        // Check if this is a workspace initialization error and we haven't retried yet
        const isWorkspaceNotRunning = responseText.includes('Workspace is not running');
        if (isWorkspaceNotRunning && !isRetry) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return attemptFetch(true);
        }
        
        console.error(`[FILE CACHE] Failed response for ${normalizedPath}: Status ${response.status}`);
        throw new Error(errorMessage);
      }
      
      return response;
    };
    
    const response = await attemptFetch();
    
    // Process content based on type
    let content;
    
    if (effectiveType === 'json') {
      content = await response.json();
    } else if (effectiveType === 'blob') {
      const blob = await response.blob();
      
      // For binary files, ensure correct MIME type
      const mimeType = FileCache.getMimeType(filePath);
      if (mimeType && mimeType !== blob.type) {
        content = new Blob([blob], { type: mimeType });
      } else {
        content = blob;
      }
      
      // For images and PDFs, return a blob URL for immediate use
      if (FileCache.isImageFile(filePath) || FileCache.isPdfFile(filePath)) {
        // Store the blob in cache
        FileCache.set(key, content);
        
        // Return URL for immediate use
        return URL.createObjectURL(content);
      }
    } else {
      content = await response.text();
    }
    
    // Cache the result
    FileCache.set(key, content);
    return content;
    
  } catch (err) {
    // Cache the error
    FileCache.set(key, null);
    throw err;
  }
}

// Ensure fetchFileContent correctly handles binary files by fixing the response handling:
export async function fetchFileContent(
  sandboxId: string,
  filePath: string,
  options: {
    contentType?: 'text' | 'blob' | 'json';
    token: string;
  }
): Promise<string | Blob | any> {
  const { contentType = 'text', token } = options;
  
  // For internal tracking
  const requestId = Math.random().toString(36).substring(2, 9);
  
  const attemptFetch = async (isRetry: boolean = false): Promise<string | Blob | any> => {
    try {
      // Prepare the API URL
      const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`;
      const url = new URL(apiUrl);
      url.searchParams.append('path', filePath);
      
      // Set up fetch options
      const fetchOptions: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      };
      
      // Execute fetch
      const response = await fetch(url.toString(), fetchOptions);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch file content: ${response.status} ${errorText}`);
      }
      
      // CRITICAL: Detect correct response handling based on file type
      // Excel files, PDFs and other binary documents should be handled as blobs
      const extension = filePath.split('.').pop()?.toLowerCase();
      const isBinaryFile = ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip'].includes(extension || '');
      
      // Handle response based on content type
      if (contentType === 'blob' || isBinaryFile) {
        const blob = await response.blob();
        
        // Set correct MIME type for known file types
        if (extension) {
          const mimeType = FileCache.getMimeType(filePath);
          if (mimeType && mimeType !== blob.type) {
            // Create a new blob with correct type
            return new Blob([blob], { type: mimeType });
          }
        }
        
        return blob;
      } else if (contentType === 'json') {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error: any) {
      // Check if this is a workspace initialization error and we haven't retried yet
      const isWorkspaceNotRunning = error.message?.includes('Workspace is not running');
      if (isWorkspaceNotRunning && !isRetry) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        return attemptFetch(true);
      }
      throw error;
    }
  };
  
  try {
    return await attemptFetch();
  } catch (error) {
    console.error(`[FILE CACHE] Error fetching file content:`, error);
    throw error;
  }
} 