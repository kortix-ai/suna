'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { FileCache } from './use-cached-file';

// Track in-progress image loads to prevent duplication
const inProgressImageLoads = new Map<string, Promise<string>>();

/**
 * Hook to fetch and cache image content with authentication
 */
export function useImageContent(sandboxId?: string, filePath?: string) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { session } = useAuth();

  useEffect(() => {
    if (!sandboxId || !filePath || !session?.access_token) {
      setImageUrl(null);
      return;
    }

    // Ensure path has /workspace prefix for consistent caching
    let normalizedPath = filePath;
    if (!normalizedPath.startsWith('/workspace')) {
      normalizedPath = `/workspace/${normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath}`;
    }

    // Define consistent cache keys
    const cacheKey = `${sandboxId}:${normalizedPath}:blob`;
    const loadKey = `${sandboxId}:${normalizedPath}`;
    
    // Check if image is already in cache
    const cached = FileCache.get(cacheKey);
    if (cached) {
      if (typeof cached === 'string' && cached.startsWith('blob:')) {
        setImageUrl(cached);
        return;
      } else if (cached instanceof Blob) {
        // If we have a raw blob object, create a URL from it
        try {
          const blobUrl = URL.createObjectURL(cached);
          setImageUrl(blobUrl);
          // Store the URL back in the cache
          FileCache.set(cacheKey, blobUrl);
          return;
        } catch (err) {
          console.error('[useImageContent] Error creating blob URL:', err);
          setError(new Error('Failed to create blob URL from cached blob'));
          setIsLoading(false);
        }
      } else {
        setImageUrl(String(cached));
        return;
      }
    }

    // Check if this image is already being loaded by another component
    if (inProgressImageLoads.has(loadKey)) {
      setIsLoading(true);
      
      inProgressImageLoads.get(loadKey)!
        .then(blobUrl => {
          setImageUrl(blobUrl);
          setIsLoading(false);
        })
        .catch(err => {
          console.error('[useImageContent] Error from in-progress load:', err);
          setError(err);
          setIsLoading(false);
        });
      
      return;
    }
    setIsLoading(true);
    
    // Create a URL for the fetch request
    const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
    url.searchParams.append('path', normalizedPath);
    
    // Create a promise for this load and track it
    const loadPromise = fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
        }
        return response.blob();
      })
      .then(blob => {
        // Create a blob URL from the image data
        const blobUrl = URL.createObjectURL(blob);
        // Cache both the blob and the URL
        FileCache.set(cacheKey, blobUrl);
        
        return blobUrl;
      });
    
    // Store the promise in the in-progress map
    inProgressImageLoads.set(loadKey, loadPromise);
    
    // Now use the promise for our state
    loadPromise
      .then(blobUrl => {
        setImageUrl(blobUrl);
        setIsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load image:', err);
        console.error('Image loading details:', { 
          sandboxId, 
          filePath, 
          normalizedPath,
          hasToken: !!session?.access_token,
          backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL 
        });
        setError(err);
        setIsLoading(false);
      })
      .finally(() => {
        // Remove from in-progress map when done
        inProgressImageLoads.delete(loadKey);
      });

    // Clean up function to handle component unmount
    return () => {
      // We don't revoke the objectURL here because it's cached
      // The URLs will be revoked when the cache entry is replaced or on page unload
    };
  }, [sandboxId, filePath, session?.access_token]);

  return {
    data: imageUrl,
    isLoading,
    error
  };
}