import React from 'react';
import { useQuery } from '@tanstack/react-query';

/**
 * Fetch an external image URL (e.g., S3 URL) with retry logic
 * Converts the blob to an object URL for use in img tags
 */
async function fetchExternalImage(url: string): Promise<string> {
  if (!url) {
    throw new Error('Image URL is required');
  }

  // If it's already a data URL, return as-is
  if (url.startsWith('data:')) {
    return url;
  }

  const response = await fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  
  // Validate it's actually an image
  if (!blob.type.startsWith('image/')) {
    throw new Error(`Invalid image type: ${blob.type}`);
  }

  return URL.createObjectURL(blob);
}

/**
 * Hook for fetching external image URLs with retry logic
 * Returns an object URL that can be used in img tags
 */
export function useExternalImage(
  imageUrl: string | null | undefined,
  options: {
    enabled?: boolean;
    staleTime?: number;
  } = {}
) {
  const {
    data: blobData,
    isLoading,
    error,
    failureCount,
  } = useQuery({
    queryKey: ['external-image', imageUrl],
    queryFn: async () => {
      if (!imageUrl) {
        throw new Error('Image URL is required');
      }
      return fetchExternalImage(imageUrl);
    },
    enabled: Boolean(imageUrl && (options.enabled !== false)),
    staleTime: options.staleTime || 10 * 60 * 1000, // 10 minutes default
    gcTime: 15 * 60 * 1000, // 15 minutes
    // Smart retry with exponential backoff
    retry: (failureCount, error: any) => {
      // Don't retry on 404 or auth errors
      if (
        error?.message?.includes('404') ||
        error?.message?.includes('401') ||
        error?.message?.includes('403')
      ) {
        return false;
      }
      // Retry up to 10 times for network errors
      return failureCount < 10;
    },
    retryDelay: (attemptIndex) => {
      // Progressive exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attemptIndex), 30000); // Cap at 30s
      return delay;
    },
  });

  // Cleanup object URLs when they change or component unmounts
  React.useEffect(() => {
    const currentUrl = blobData;
    
    return () => {
      // Cleanup the object URL when it changes or component unmounts
      if (currentUrl && typeof currentUrl === 'string' && currentUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [blobData]);

  return {
    data: blobData || null, // Only return the blob URL when ready, don't fallback to original
    isLoading,
    error,
    failureCount,
  };
}

