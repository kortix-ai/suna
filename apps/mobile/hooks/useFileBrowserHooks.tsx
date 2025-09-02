import {
    downloadFile,
    getFileContent,
    listDirectoryFiles
} from '@/api/sandbox-file-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';

// Query Keys - make sure they don't conflict with existing image cache
export const fileBrowserKeys = {
    all: ['file-browser'] as const,
    directories: () => [...fileBrowserKeys.all, 'directories'] as const,
    directory: (sandboxId: string, path: string) =>
        [...fileBrowserKeys.directories(), sandboxId, path] as const,
    contents: () => [...fileBrowserKeys.all, 'file-contents'] as const, // Changed to avoid conflict
    content: (sandboxId: string, filePath: string) =>
        [...fileBrowserKeys.contents(), sandboxId, filePath] as const,
};

// Directory listing hook
export const useDirectoryListing = (sandboxId: string | null, path: string, enabled: boolean = true) => {
    console.log(`[DIRECTORY-HOOK] useDirectoryListing called:`);
    console.log(`[DIRECTORY-HOOK] - sandboxId: ${sandboxId}`);
    console.log(`[DIRECTORY-HOOK] - path: ${path}`);
    console.log(`[DIRECTORY-HOOK] - enabled: ${enabled}`);

    return useQuery({
        queryKey: sandboxId && enabled ? fileBrowserKeys.directory(sandboxId, path) : [],
        queryFn: async () => {
            console.log(`[DIRECTORY-HOOK] queryFn executing for ${sandboxId}:${path}`);
            const result = await listDirectoryFiles(sandboxId!, path);
            console.log(`[DIRECTORY-HOOK] queryFn result:`, result);
            console.log(`[DIRECTORY-HOOK] queryFn result type:`, typeof result);
            console.log(`[DIRECTORY-HOOK] queryFn result isArray:`, Array.isArray(result));
            return result;
        },
        enabled: !!sandboxId && enabled,
        staleTime: 30 * 1000, // 30 seconds
        retry: 2,
    });
};

// File content hook (for text files only, images use useImageContent)
export const useFileContent = (sandboxId: string | null, filePath: string | null) => {
    return useQuery({
        queryKey: sandboxId && filePath ? fileBrowserKeys.content(sandboxId, filePath) : [],
        queryFn: () => getFileContent(sandboxId!, filePath!),
        enabled: !!sandboxId && !!filePath,
        staleTime: 2 * 60 * 1000, // 2 minutes
        retry: 1,
    });
};

// File download hook - simplified for basic functionality
export const useFileDownload = () => {
    return useMutation({
        mutationFn: async ({
            sandboxId,
            filePath
        }: {
            sandboxId: string;
            filePath: string;
        }) => {
            try {
                // Get file blob from server
                const blob = await downloadFile(sandboxId, filePath);

                // Get file name
                const fileName = filePath.split('/').pop() || 'download';

                // For now, just return the blob and show success
                // In a future update, this can be enhanced with file system operations
                return { success: true, blob, fileName };
            } catch (error) {
                console.error('Download failed:', error);
                throw error;
            }
        },
        onSuccess: (data) => {
            Alert.alert(
                'Download Ready',
                `${data.fileName} is ready for download. File size: ${(data.blob.size / 1024).toFixed(1)} KB`,
                [{ text: 'OK' }]
            );
        },
        onError: (error) => {
            const message = error instanceof Error ? error.message : 'Download failed';
            Alert.alert(
                'Download Failed',
                message,
                [{ text: 'OK' }]
            );
        },
    });
};

// Refresh directory hook
export const useRefreshDirectory = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
            sandboxId,
            path
        }: {
            sandboxId: string;
            path: string;
        }) => {
            await queryClient.invalidateQueries({
                queryKey: fileBrowserKeys.directory(sandboxId, path),
            });
            return { sandboxId, path };
        },
    });
};

// Prefetch directory hook for performance
export const usePrefetchDirectory = () => {
    const queryClient = useQueryClient();

    return (sandboxId: string, path: string) => {
        queryClient.prefetchQuery({
            queryKey: fileBrowserKeys.directory(sandboxId, path),
            queryFn: () => listDirectoryFiles(sandboxId, path),
            staleTime: 30 * 1000,
        });
    };
}; 