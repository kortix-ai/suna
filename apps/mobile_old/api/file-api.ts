import type { FileDownload } from '@/stores/ui-store';
import {
    useAddFileDownload,
    useUpdateFileDownload
} from '@/stores/ui-store';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// File manifest types (stored in Query - persistent)
export interface FileManifest {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
  downloadUrl?: string;
}

export interface FolderStructure {
  id: string;
  name: string;
  path: string;
  files: FileManifest[];
  folders: FolderStructure[];
}

// File manifests query (persisted with async storage)
export const useFileManifests = (folderId?: string) => {
  return useQuery({
    queryKey: ['file-manifest', folderId || 'root'],
    queryFn: async (): Promise<FolderStructure> => {
      const url = folderId ? `/api/files/folders/${folderId}` : '/api/files/folders/root';
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error('Failed to fetch file manifests');
      }
      
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes - persistent data
  });
};

// File search query (persisted)
export const useFileSearch = (searchTerm: string) => {
  return useQuery({
    queryKey: ['file-manifest', 'search', searchTerm],
    queryFn: async (): Promise<FileManifest[]> => {
      if (!searchTerm.trim()) return [];
      
      const response = await fetch(`/api/files/search?q=${encodeURIComponent(searchTerm)}`);
      
      if (!response.ok) {
        throw new Error('Failed to search files');
      }
      
      return response.json();
    },
    enabled: searchTerm.length > 2,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

// File download hook (combines Query for metadata, Zustand for progress)
export const useFileDownload = () => {
  const addFileDownload = useAddFileDownload();
  const updateFileDownload = useUpdateFileDownload();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fileId, localPath }: { fileId: string; localPath: string }) => {
      // Get file metadata from cache or fetch
      const fileManifest = queryClient.getQueryData<FileManifest>(['file-manifest', 'file', fileId]);
      
      if (!fileManifest) {
        throw new Error('File manifest not found');
      }

      // Initialize download in Zustand (local state)
      const download: FileDownload = {
        id: fileId,
        localPath,
        progress: 0,
        status: 'pending',
      };
      
      addFileDownload(download);

      try {
        // Start download
        updateFileDownload(fileId, { status: 'downloading' });
        
        const response = await fetch(fileManifest.downloadUrl || `/api/files/${fileId}/download`);
        
        if (!response.ok) {
          throw new Error(`Download failed: ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        
        let loaded = 0;
        const reader = response.body?.getReader();
        
        if (!reader) {
          throw new Error('Failed to create reader');
        }

        // Stream download with progress updates
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;
          
          loaded += value.length;
          const progress = total > 0 ? (loaded / total) * 100 : 0;
          
          updateFileDownload(fileId, { 
            progress: Math.round(progress),
            status: 'downloading'
          });
        }

        // Complete download
        updateFileDownload(fileId, { 
          status: 'completed',
          progress: 100
        });

        return { fileId, localPath, success: true };
      } catch (error) {
        updateFileDownload(fileId, { 
          status: 'error',
          error: error instanceof Error ? error.message : 'Download failed'
        });
        throw error;
      }
    },
  });
};

// Upload file mutation
export const useFileUpload = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      file, 
      folderId, 
      onProgress 
    }: { 
      file: File | Blob; 
      folderId?: string; 
      onProgress?: (progress: number) => void;
    }) => {
      const formData = new FormData();
      formData.append('file', file);
      if (folderId) {
        formData.append('folderId', folderId);
      }

      const xhr = new XMLHttpRequest();
      
      return new Promise<FileManifest>((resolve, reject) => {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && onProgress) {
            const progress = (e.loaded / e.total) * 100;
            onProgress(Math.round(progress));
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              resolve(response);
            } catch (e) {
              reject(new Error('Invalid response format'));
            }
          } else {
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        });

        xhr.addEventListener('error', () => {
          reject(new Error('Upload failed'));
        });

        const url = folderId ? `/api/files/folders/${folderId}/upload` : '/api/files/upload';
        xhr.open('POST', url);
        xhr.send(formData);
      });
    },
    onSuccess: (newFile, { folderId }) => {
      // Invalidate file manifests to include new file
      queryClient.invalidateQueries({ 
        queryKey: ['file-manifest', folderId || 'root'] 
      });
      queryClient.invalidateQueries({ 
        queryKey: ['file-manifest', 'search'] 
      });
    },
  });
};

// Delete file mutation
export const useFileDelete = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string) => {
      const response = await fetch(`/api/files/${fileId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete file');
      }
    },
    onSuccess: (_, fileId) => {
      // Remove from all relevant caches
      queryClient.invalidateQueries({ queryKey: ['file-manifest'] });
      queryClient.removeQueries({ queryKey: ['file-manifest', 'file', fileId] });
    },
  });
}; 