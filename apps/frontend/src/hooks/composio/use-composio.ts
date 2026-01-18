'use client';

import { useMutation, useQueryClient, useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { 
  composioApi, 
  type ComposioToolkitsResponse,
  type CompositoCategoriesResponse,
  type CreateComposioProfileRequest,
  type CreateComposioProfileResponse,
  type DetailedComposioToolkitResponse,
  type ComposioToolsResponse,
} from './utils';
import { composioKeys } from './keys';
import { toast } from '@/lib/toast';
import { useState, useEffect, useCallback, useRef } from 'react';

const POPULAR_TOOLKIT_SLUGS = [
  'gmail', 'googledrive', 'googlecalendar', 'googlesheets', 'googledocs',
  'slack', 'notion', 'github', 'linear', 'asana', 'trello', 'jira',
  'discord', 'twitter', 'linkedin', 'hubspot', 'salesforce', 'zendesk',
  'dropbox', 'airtable', 'figma', 'stripe', 'shopify', 'mailchimp'
];

export const useComposioCategories = () => {
  return useQuery({
    queryKey: composioKeys.categories(),
    queryFn: async (): Promise<CompositoCategoriesResponse> => {
      const result = await composioApi.getCategories();
      return result;
    },
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

export const useComposioToolkits = (search?: string, category?: string) => {
  return useQuery({
    queryKey: composioKeys.toolkits(search, category),
    queryFn: async (): Promise<ComposioToolkitsResponse> => {
      const result = await composioApi.getToolkits(search, category);
      return result;
    },
    staleTime: 5 * 60 * 1000, 
    retry: 2,
  });
};

export const useComposioToolkitsInfinite = (search?: string, category?: string) => {
  return useInfiniteQuery({
    queryKey: ['composio', 'toolkits', 'infinite', search, category],
    queryFn: async ({ pageParam }): Promise<ComposioToolkitsResponse> => {
      const result = await composioApi.getToolkits(search, category, pageParam);
      return result;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      return lastPage.next_cursor || undefined;
    },
    staleTime: 5 * 60 * 1000,
    retry: 2,
  });
};

export const useComposioToolkitIcon = (toolkitSlug: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['composio', 'toolkit-icon', toolkitSlug],
    queryFn: async (): Promise<{ success: boolean; icon_url?: string }> => {
      const result = await composioApi.getToolkitIcon(toolkitSlug);
      return result;
    },
    enabled: options?.enabled !== undefined ? options.enabled : !!toolkitSlug,
    staleTime: 60 * 60 * 1000,
    retry: 2,
  });
};

export const usePrefetchComposioIcons = () => {
  const queryClient = useQueryClient();
  const prefetchedRef = useRef(false);

  const prefetchIcons = useCallback(async (slugs?: string[]) => {
    const slugsToFetch = slugs || POPULAR_TOOLKIT_SLUGS;
    
    // Filter out already cached slugs
    const uncachedSlugs = slugsToFetch.filter(slug => {
      const cached = queryClient.getQueryData(['composio', 'toolkit-icon', slug]);
      return !cached;
    });

    if (uncachedSlugs.length === 0) return;

    try {
      const result = await composioApi.getToolkitIconsBatch(uncachedSlugs);
      
      if (result.success && result.icons) {
        // Populate React Query cache for each icon
        Object.entries(result.icons).forEach(([slug, iconUrl]) => {
          queryClient.setQueryData(
            ['composio', 'toolkit-icon', slug],
            { success: true, icon_url: iconUrl }
          );
        });
        
        // Also set empty results for slugs that had no icon
        uncachedSlugs.forEach(slug => {
          if (!result.icons[slug]) {
            queryClient.setQueryData(
              ['composio', 'toolkit-icon', slug],
              { success: false, icon_url: undefined }
            );
          }
        });
      }
    } catch (error) {
      console.debug('Failed to prefetch Composio icons:', error);
    }
  }, [queryClient]);

  // Auto-prefetch popular icons on first call
  const prefetchPopularIcons = useCallback(() => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;
    prefetchIcons();
  }, [prefetchIcons]);

  return { prefetchIcons, prefetchPopularIcons };
};

export const useComposioToolkitDetails = (toolkitSlug: string, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ['composio', 'toolkit-details', toolkitSlug],
    queryFn: async (): Promise<DetailedComposioToolkitResponse> => {
      const result = await composioApi.getToolkitDetails(toolkitSlug);
      return result;
    },
    enabled: options?.enabled !== undefined ? options.enabled : !!toolkitSlug,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

export const useComposioTools = (toolkitSlug: string, options?: { enabled?: boolean; limit?: number }) => {
  return useQuery({
    queryKey: ['composio', 'tools', toolkitSlug, options?.limit],
    queryFn: async (): Promise<ComposioToolsResponse> => {
      const result = await composioApi.getTools(toolkitSlug, options?.limit);
      return result;
    },
    enabled: (options?.enabled ?? true) && !!toolkitSlug,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });
};

export const useCreateComposioProfile = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (request: CreateComposioProfileRequest): Promise<CreateComposioProfileResponse> => {
      return await composioApi.createProfile(request);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: composioKeys.profiles.all() });
      toast.success(`Connected to ${variables.profile_name}!`);
      
      // If there's a redirect URL, open it automatically
      if (data.redirect_url) {
        window.open(data.redirect_url, '_blank', 'width=600,height=700,resizable=yes,scrollbars=yes');
      }
    },
    onError: (error) => {
      console.error('Failed to create Composio profile:', error);
      toast.error(error.message || 'Failed to create profile');
    },
  });
};

export const useInvalidateComposioQueries = () => {
  const queryClient = useQueryClient();
  
  return () => {
    queryClient.invalidateQueries({ queryKey: composioKeys.all });
  };
}; 

export const useCheckProfileNameAvailability = (
  toolkitSlug: string,
  profileName: string,
  options?: {
    enabled?: boolean;
    debounceMs?: number;
  }
) => {
  const [debouncedName, setDebouncedName] = useState(profileName);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedName(profileName);
    }, options?.debounceMs || 500);

    return () => clearTimeout(timer);
  }, [profileName, options?.debounceMs]);

  return useQuery({
    queryKey: ['composio', 'profile-name-availability', toolkitSlug, debouncedName],
    queryFn: async () => {
      if (!debouncedName || debouncedName.trim().length < 1) {
        return {
          available: true,
          message: '',
          suggestions: []
        };
      }
      
      const response = await composioApi.checkProfileNameAvailability(toolkitSlug, debouncedName);
      return response;
    },
    enabled: options?.enabled !== false && !!toolkitSlug && !!debouncedName && debouncedName.trim().length > 0,
    staleTime: 30000, // Consider data stale after 30 seconds
    gcTime: 60000, // Keep in cache for 1 minute
  });
}; 