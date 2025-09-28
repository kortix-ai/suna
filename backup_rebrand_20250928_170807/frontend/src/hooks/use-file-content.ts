'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { FileCache, getCachedFile } from './use-cached-file';

// Query keys for file content
export const fileContentKeys = {
  all: ['file-content'] as const,
  byPath: (sandboxId: string, path: string) => 
    [...fileContentKeys.all, sandboxId, path] as const,
};

/**
 * Hook to fetch and cache file content with authentication
 */
export function useFileContent(sandboxId?: string, filePath?: string) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { session } = useAuth();

  useEffect(() => {
    if (!sandboxId || !filePath) {
      setContent(null);
      return;
    }

    const cacheKey = `${sandboxId}:${filePath}:text`;
    
    // Check if file content is already in cache
    const cached = FileCache.get(cacheKey);
    if (cached !== null) {
      setContent(cached);
      return;
    }

    // Otherwise, load and cache the file content
    setIsLoading(true);
    getCachedFile(sandboxId, filePath, {
      token: session?.access_token || '',
      contentType: 'text'
    })
      .then(fileContent => {
        setContent(fileContent);
        setIsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load file content:', err);
        setError(err);
        setIsLoading(false);
      });
  }, [sandboxId, filePath, session?.access_token]);

  return {
    data: content,
    isLoading,
    error
  };
} 