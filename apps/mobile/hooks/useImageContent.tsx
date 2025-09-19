import { SERVER_URL } from '@/constants/Server';
import { createSupabaseClient } from '@/constants/SupabaseConfig';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

interface ImageContentResult {
    data: string | null;
    isLoading: boolean;
    error: Error | null;
    isProcessing: boolean; // New state for server processing
}

// Optimistic cache for uploaded files
const uploadCache = new Map<string, Blob>();

// Convert blob to base64 data URL for React Native
const blobToDataURL = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

export function useImageContent(
    sandboxId?: string,
    filePath?: string,
    uploadedBlob?: Blob // For optimistic caching
): ImageContentResult {
    const [imageUrl, setImageUrl] = useState<string | null>(null);

    // Normalize path
    const normalizedPath = filePath && !filePath.startsWith('/workspace')
        ? `/workspace/${filePath.startsWith('/') ? filePath.substring(1) : filePath}`
        : filePath;

    const cacheKey = `${sandboxId}:${normalizedPath}`;
    // Use path-only key for optimistic caching to survive sandboxId changes
    const optimisticCacheKey = normalizedPath;

    // Debug logging
    console.log(`[useImageContent] ${filePath} - sandboxId: ${sandboxId || 'none'}, uploadedBlob: ${uploadedBlob ? 'yes' : 'no'}`);

    // Optimistic caching for uploads
    useEffect(() => {
        if (uploadedBlob && optimisticCacheKey) {
            console.log(`[useImageContent] SETTING OPTIMISTIC CACHE - ${optimisticCacheKey}`);
            uploadCache.set(optimisticCacheKey, uploadedBlob);
            // Auto-expire after 2 minutes (longer to allow for server processing)
            setTimeout(() => {
                console.log(`[useImageContent] EXPIRING CACHE - ${optimisticCacheKey}`);
                uploadCache.delete(optimisticCacheKey);
            }, 120000);
        }
    }, [uploadedBlob, optimisticCacheKey]);

    // Smart fetch with retry logic
    const {
        data: blobData,
        isLoading,
        error,
    } = useQuery({
        queryKey: ['image', sandboxId, normalizedPath],
        queryFn: async () => {
            console.log(`[useImageContent] QUERY FUNCTION CALLED - ${cacheKey}`);

            // Check optimistic cache first (try both full key and path-only key)
            const cachedBlob = uploadCache.get(cacheKey) || (optimisticCacheKey ? uploadCache.get(optimisticCacheKey) : null);
            if (cachedBlob) {
                const sourceKey = uploadCache.get(cacheKey) ? cacheKey : optimisticCacheKey;
                console.log(`[useImageContent] USING OPTIMISTIC CACHE - ${filePath} (key: ${sourceKey})`);
                return cachedBlob;
            }

            console.log(`[useImageContent] NO CACHE, FETCHING FROM SERVER - ${filePath}`);

            // Fetch from server
            const supabase = createSupabaseClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                console.log(`[useImageContent] NO AUTH TOKEN - ${filePath}`);
                throw new Error('No auth token');
            }

            const url = new URL(`${SERVER_URL}/sandboxes/${sandboxId}/files/content`);
            url.searchParams.append('path', normalizedPath!);

            console.log(`[useImageContent] FETCHING URL - ${url.toString()}`);

            const response = await fetch(url.toString(), {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                },
            });

            console.log(`[useImageContent] FETCH RESPONSE - ${filePath}: ${response.status}`);

            if (!response.ok) {
                const errorMsg = `Failed to load image: ${response.status}`;
                console.log(`[useImageContent] FETCH ERROR - ${filePath}: ${errorMsg}`);
                throw new Error(errorMsg);
            }

            const blob = await response.blob();
            console.log(`[useImageContent] FETCH SUCCESS - ${filePath}, blob size: ${blob.size}`);

            // Clean up optimistic cache since we now have server data
            if (optimisticCacheKey && uploadCache.has(optimisticCacheKey)) {
                console.log(`[useImageContent] CLEANING UP OPTIMISTIC CACHE - ${optimisticCacheKey}`);
                uploadCache.delete(optimisticCacheKey);
            }

            return blob;
        },
        enabled: Boolean(sandboxId && normalizedPath),
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: (failureCount, error: any) => {
            // Smart retry for 404s (server processing)
            if (error?.message?.includes('404')) {
                return failureCount < 3;
            }
            // Don't retry auth errors
            if (error?.message?.includes('401') || error?.message?.includes('403')) {
                return false;
            }
            return failureCount < 2;
        },
        retryDelay: (attemptIndex) => {
            // Exponential backoff: 1s, 2s, 4s
            return Math.min(1000 * (2 ** attemptIndex), 4000);
        },
    });

    // Convert blob to data URL - KEEP EXISTING URL UNTIL NEW ONE IS READY
    useEffect(() => {
        console.log(`[useImageContent] BLOB TO URL EFFECT - ${cacheKey}`);
        console.log(`[useImageContent] - blobData type: ${blobData ? typeof blobData : 'none'}`);
        console.log(`[useImageContent] - blobData instanceof Blob: ${blobData instanceof Blob}`);

        if (blobData instanceof Blob) {
            console.log(`[useImageContent] CONVERTING BLOB TO DATA URL - ${cacheKey}, size: ${blobData.size}`);
            blobToDataURL(blobData)
                .then((dataUrl) => {
                    console.log(`[useImageContent] BLOB CONVERSION SUCCESS - ${cacheKey}`);
                    console.log(`[useImageContent] - dataUrl length: ${dataUrl.length}`);
                    setImageUrl(dataUrl);
                })
                .catch((error) => {
                    console.error(`[useImageContent] BLOB CONVERSION ERROR - ${cacheKey}:`, error);
                });
        } else if (!isLoading) {
            // Only clear URL if we're not currently loading (to preserve cached images)
            console.log(`[useImageContent] NO BLOB DATA AND NOT LOADING, SETTING URL TO NULL - ${cacheKey}`);
            setImageUrl(null);
        } else {
            console.log(`[useImageContent] NO BLOB DATA BUT LOADING, KEEPING EXISTING URL - ${cacheKey}`);
        }
    }, [blobData, cacheKey, isLoading]);

    const isProcessing = error?.message?.includes('404') && isLoading;

    // Log final state  
    const imageSource = imageUrl ? (imageUrl.startsWith('data:') ? 'CACHED' : 'SERVER') : 'NONE';
    const cacheStatus = sandboxId ? 'with-sandbox' : 'no-sandbox';
    console.log(`[useImageContent] ${filePath} returning: ${imageSource}${isLoading ? ' (loading)' : ''} [${cacheStatus}]`);

    return {
        data: imageUrl,
        isLoading,
        error,
        isProcessing,
    };
}

// Utility for optimistic caching of uploaded files
export function cacheUploadedFile(sandboxId: string, filePath: string, blob: Blob) {
    const normalizedPath = !filePath.startsWith('/workspace')
        ? `/workspace/${filePath.startsWith('/') ? filePath.substring(1) : filePath}`
        : filePath;
    const cacheKey = `${sandboxId}:${normalizedPath}`;

    uploadCache.set(cacheKey, blob);
    console.log(`[IMAGE] Cached uploaded file: ${filePath}`);

    // Auto-expire after 2 minutes (longer to allow for server processing)
    setTimeout(() => {
        uploadCache.delete(cacheKey);
        console.log(`[IMAGE] Expired cache for: ${filePath}`);
    }, 120000);
} 