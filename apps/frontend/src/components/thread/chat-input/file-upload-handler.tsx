'use client';

import React, { forwardRef, useEffect, memo } from 'react';
import { Button } from '@/components/ui/button';
import { Paperclip } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { toast } from '@/lib/toast';
import { createClient } from '@/lib/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { UploadedFile } from './chat-input';
import { normalizeFilenameToNFC, normalizeMimeType } from '@agentpress/shared';
import { backendApi } from '@/lib/api-client';
import JSZip from 'jszip';
import {
  UPLOAD_LIMITS,
  ALLOWED_EXTENSIONS,
  isAllowedFile,
  isExtractableArchive,
  formatFileSize,
} from '@/lib/constants/upload-limits';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

const ALLOWED_EXTENSIONS_STRING = ALLOWED_EXTENSIONS.join(',');

interface StageFileResponse {
  file_id: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  status: string;
}

const stageFileToS3 = async (
  file: File,
  fileId: string,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
): Promise<void> => {
  const normalizedName = normalizeFilenameToNFC(file.name);
  
  try {
    const formData = new FormData();
    formData.append('file', file, normalizedName);
    formData.append('file_id', fileId);
    
    const response = await backendApi.upload<StageFileResponse>(
      '/files/stage',
      formData,
      { showErrors: false }
    );
    
    if (response.error) {
      throw new Error(response.error.message || 'Upload failed');
    }
    
    setUploadedFiles((prev) => 
      prev.map((f) => 
        f.fileId === fileId 
          ? { ...f, status: 'ready' as const }
          : f
      )
    );
    
  } catch (error) {
    console.error(`Failed to stage file ${normalizedName}:`, error);
    setUploadedFiles((prev) => 
      prev.map((f) => 
        f.fileId === fileId 
          ? { ...f, status: 'error' as const }
          : f
      )
    );
    toast.error(`Failed to upload: ${normalizedName}`);
  }
};

const handleLocalFilesOptimistic = async (
  files: File[],
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
) => {
  const processedFiles: File[] = [];
  
  for (const file of files) {
    if (isExtractableArchive(file)) {
      const extracted = await extractZipFiles(file);
      processedFiles.push(...extracted);
    } else {
      const validation = isAllowedFile(file);
      if (!validation.allowed) {
        toast.error(`${file.name}: ${validation.reason}`);
        continue;
      }
      processedFiles.push(file);
    }
  }
  
  if (processedFiles.length === 0) return;

  const newUploadedFiles: UploadedFile[] = processedFiles.map((file) => {
    const normalizedName = normalizeFilenameToNFC(file.name);
    const fileId = crypto.randomUUID();

    return {
      name: normalizedName,
      path: `/workspace/uploads/${normalizedName}`,
      size: file.size,
      type: file.type || 'application/octet-stream',
      localUrl: URL.createObjectURL(file),
      fileId,
      status: 'pending' as const,
    };
  });

  setPendingFiles((prevFiles) => [...prevFiles, ...processedFiles]);
  setUploadedFiles((prev) => [...prev, ...newUploadedFiles]);
};

const extractZipFiles = async (zipFile: File): Promise<File[]> => {
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const extractedFiles: File[] = [];
    let totalSize = 0;
    let fileCount = 0;
    
    const entries = Object.entries(zip.files).filter(([_, file]) => !file.dir);
    
    if (entries.length > UPLOAD_LIMITS.MAX_ZIP_FILES) {
      toast.error(`Zip contains too many files (${entries.length}). Max: ${UPLOAD_LIMITS.MAX_ZIP_FILES}`);
      return [];
    }
    
    for (const [path, file] of entries) {
      const filename = path.split('/').pop() || path;
      const content = await file.async('blob');
      
      totalSize += content.size;
      if (totalSize > UPLOAD_LIMITS.MAX_ZIP_TOTAL_SIZE_BYTES) {
        toast.error(`Zip total size exceeds ${formatFileSize(UPLOAD_LIMITS.MAX_ZIP_TOTAL_SIZE_BYTES)} limit`);
        return [];
      }
      
      if (content.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
        toast.warning(`Skipping ${filename}: exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit`);
        continue;
      }
      
      const ext = '.' + filename.split('.').pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext as any)) {
        toast.warning(`Skipping ${filename}: unsupported file type`);
        continue;
      }
      
      const rawMimeType = content.type || 'application/octet-stream';
      const normalizedMimeType = normalizeMimeType(rawMimeType);
      const extractedFile = new File([content], filename, { type: normalizedMimeType });
      extractedFiles.push(extractedFile);
      fileCount++;
    }
    
    if (fileCount > 0) {
      toast.success(`Extracted ${fileCount} files from ${zipFile.name}`);
    }
    
    return extractedFiles;
  } catch (error) {
    console.error('Failed to extract zip:', error);
    toast.error(`Failed to extract ${zipFile.name}`);
    return [];
  }
};

const handleLocalFiles = async (
  files: File[],
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
  setIsUploading?: React.Dispatch<React.SetStateAction<boolean>>,
) => {
  const processedFiles: File[] = [];
  
  for (const file of files) {
    if (isExtractableArchive(file)) {
      const extracted = await extractZipFiles(file);
      processedFiles.push(...extracted);
    } else {
      const validation = isAllowedFile(file);
      if (!validation.allowed) {
        toast.error(`${file.name}: ${validation.reason}`);
        continue;
      }
      processedFiles.push(file);
    }
  }
  
  const filteredFiles = processedFiles;

  if (filteredFiles.length === 0) return;

  const newUploadedFiles: UploadedFile[] = filteredFiles.map((file) => {
    const normalizedName = normalizeFilenameToNFC(file.name);
    const fileId = crypto.randomUUID();

    return {
      name: normalizedName,
      path: `/workspace/uploads/${normalizedName}`,
      size: file.size,
      type: file.type || 'application/octet-stream',
      localUrl: URL.createObjectURL(file),
      fileId,
      status: 'pending' as const,
    };
  });

  setPendingFiles((prevFiles) => [...prevFiles, ...filteredFiles]);
  setUploadedFiles((prev) => [...prev, ...newUploadedFiles]);
};

const uploadFiles = async (
  files: File[],
  sandboxId: string,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>,
  messages: any[] = [], // Add messages parameter to check for existing files
  queryClient?: any, // Add queryClient parameter for cache invalidation
  setPendingFiles?: React.Dispatch<React.SetStateAction<File[]>>, // Add setPendingFiles to clear pending files after upload
) => {
  try {
    setIsUploading(true);

    const fileUploadResults: Array<{ originalName: string; uploadedFile: UploadedFile }> = [];

    for (const file of files) {
      if (file.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
        toast.error(`File size exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit: ${file.name}`);
        continue;
      }

      const normalizedName = normalizeFilenameToNFC(file.name);
      const uploadPath = `/workspace/uploads/${normalizedName}`;

      const formData = new FormData();
      formData.append('file', file, normalizedName);
      formData.append('path', uploadPath);

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        // Handle HTTP 431 - Request Header Fields Too Large
        if (response.status === 431) {
          throw new Error('Request is too large. Try uploading one file at a time.');
        }
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      // Parse response to get the actual path used by the server
      const responseData = await response.json();
      const actualPath = responseData.path || uploadPath;
      const finalFilename = responseData.final_filename || normalizedName;
      const wasRenamed = responseData.renamed || false;

      // Check if this filename already exists in chat messages
      const isFileInChat = messages.some(message => {
        const content = typeof message.content === 'string' ? message.content : '';
        return content.includes(`[Uploaded File: ${actualPath}]`);
      });

      // If file was already in chat and we have queryClient, invalidate its cache
      if (isFileInChat && queryClient) {
        // Invalidate all content types for this file
        ['text', 'blob', 'json'].forEach(contentType => {
          const queryKey = fileQueryKeys.content(sandboxId, actualPath, contentType);
          queryClient.removeQueries({ queryKey });
        });

        // Also invalidate directory listing
        queryClient.invalidateQueries({
          queryKey: fileQueryKeys.directory(sandboxId, '/workspace/uploads'),
        });
      }

      fileUploadResults.push({
        originalName: normalizedName,
        uploadedFile: {
          name: finalFilename,
          path: actualPath,
          size: file.size,
          type: file.type || 'application/octet-stream',
        },
      });

      if (wasRenamed) {
        toast.success(`File uploaded as: ${finalFilename} (renamed to avoid conflict)`);
      } else {
        toast.success(`File uploaded: ${finalFilename}`);
      }
    }

    setUploadedFiles((prev) => {
      const updated = [...prev];
      for (const { originalName, uploadedFile } of fileUploadResults) {
        const index = updated.findIndex(f => normalizeFilenameToNFC(f.name) === normalizeFilenameToNFC(originalName) && f.status === 'pending');
        if (index !== -1) {
          updated[index] = { ...updated[index], ...uploadedFile, status: 'ready' as const };
        } else {
          updated.push({ ...uploadedFile, status: 'ready' as const });
        }
      }
      return updated;
    });

    // Clear pending files after successful upload
    if (setPendingFiles) {
      setPendingFiles([]);
    }
  } catch (error) {
    console.error('File upload failed:', error);
    toast.error(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Failed to upload file',
    );
  } finally {
    setIsUploading(false);
  }
};

const uploadFilesToProject = async (
  files: File[],
  projectId: string,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>,
  setPendingFiles?: React.Dispatch<React.SetStateAction<File[]>>,
) => {
  try {
    setIsUploading(true);

    const fileUploadResults: Array<{ originalName: string; uploadedFile: UploadedFile }> = [];

    for (const file of files) {
      if (file.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
        toast.error(`File size exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit: ${file.name}`);
        continue;
      }

      const normalizedName = normalizeFilenameToNFC(file.name);
      const uploadPath = `/workspace/uploads/${normalizedName}`;

      const formData = new FormData();
      formData.append('file', file, normalizedName);
      formData.append('path', uploadPath);

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No access token available');
      }

      const response = await fetch(`${API_URL}/project/${projectId}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        // Handle HTTP 431 - Request Header Fields Too Large
        if (response.status === 431) {
          throw new Error('Request is too large. Try uploading one file at a time.');
        }
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const responseData = await response.json();
      const actualPath = responseData.path || uploadPath;
      const finalFilename = responseData.final_filename || normalizedName;
      const wasRenamed = responseData.renamed || false;

      fileUploadResults.push({
        originalName: normalizedName,
        uploadedFile: {
          name: finalFilename,
          path: actualPath,
          size: file.size,
          type: file.type || 'application/octet-stream',
        },
      });

      if (wasRenamed) {
        toast.success(`File uploaded as: ${finalFilename} (renamed to avoid conflict)`);
      } else {
        toast.success(`File uploaded: ${finalFilename}`);
      }
    }

    setUploadedFiles((prev) => {
      const updated = [...prev];
      for (const { originalName, uploadedFile } of fileUploadResults) {
        const index = updated.findIndex(f => normalizeFilenameToNFC(f.name) === normalizeFilenameToNFC(originalName) && f.status === 'pending');
        if (index !== -1) {
          updated[index] = { ...updated[index], ...uploadedFile, status: 'ready' as const };
        } else {
          updated.push({ ...uploadedFile, status: 'ready' as const });
        }
      }
      return updated;
    });
    
    // Clear pending files after successful upload
    if (setPendingFiles) {
      setPendingFiles([]);
    }
  } catch (error) {
    console.error('File upload failed:', error);
    toast.error(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Failed to upload file',
    );
  } finally {
    setIsUploading(false);
  }
};

const handleFiles = async (
  files: File[],
  sandboxId: string | undefined,
  projectId: string | undefined,
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>,
  messages: any[] = [],
  queryClient?: any,
) => {
  // Process files (extract zips, validate)
  const processedFiles: File[] = [];
  
  for (const file of files) {
    if (isExtractableArchive(file)) {
      const extracted = await extractZipFiles(file);
      processedFiles.push(...extracted);
    } else {
      const validation = isAllowedFile(file);
      if (!validation.allowed) {
        toast.error(`${file.name}: ${validation.reason}`);
        continue;
      }
      processedFiles.push(file);
    }
  }
  
  if (processedFiles.length === 0) return;

  setIsUploading(true);

  // Always stage files via /files/stage API (simplified flow)
  for (const file of processedFiles) {
    const normalizedName = normalizeFilenameToNFC(file.name);
    const fileId = crypto.randomUUID();

    // Add to uploaded files with pending status and local preview
    setUploadedFiles((prev) => [...prev, {
      name: normalizedName,
      path: `/workspace/uploads/${normalizedName}`,
      size: file.size,
      type: file.type || 'application/octet-stream',
      localUrl: URL.createObjectURL(file),
      fileId,
      status: 'uploading' as const,
    }]);

    // Stage file to backend
    try {
      await stageFileToS3(file, fileId, setUploadedFiles);
    } catch (error) {
      console.error(`Failed to stage file ${normalizedName}:`, error);
      // Error handling is done in stageFileToS3
    }
  }

  setIsUploading(false);
};

interface FileUploadHandlerProps {
  loading: boolean;
  disabled: boolean;
  isAgentRunning: boolean;
  isUploading: boolean;
  sandboxId?: string;
  projectId?: string;
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>;
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>;
  messages?: any[]; // Add messages prop
  isLoggedIn?: boolean;
}

export const FileUploadHandler = memo(forwardRef<
  HTMLInputElement,
  FileUploadHandlerProps
>(
  (
    {
      loading,
      disabled,
      isAgentRunning,
      isUploading,
      sandboxId,
      projectId,
      setPendingFiles,
      setUploadedFiles,
      setIsUploading,
      messages = [],
      isLoggedIn = true,
    },
    ref,
  ) => {
    const queryClient = useQueryClient();
    // Clean up object URLs when component unmounts
    useEffect(() => {
      return () => {
        // Clean up any object URLs to avoid memory leaks
        setUploadedFiles(prev => {
          prev.forEach(file => {
            if (file.localUrl) {
              URL.revokeObjectURL(file.localUrl);
            }
          });
          return prev;
        });
      };
    }, []);

    const handleFileUpload = () => {
      if (ref && 'current' in ref && ref.current) {
        ref.current.click();
      }
    };

    const processFileUpload = async (
      event: React.ChangeEvent<HTMLInputElement>,
    ) => {
      if (!event.target.files || event.target.files.length === 0) return;

      const files = Array.from(event.target.files);
      // Use the helper function instead of the static method
      handleFiles(
        files,
        sandboxId,
        projectId,
        setPendingFiles,
        setUploadedFiles,
        setIsUploading,
        messages,
        queryClient,
      );

      event.target.value = '';
    };

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-block">
              <Button
                type="button"
                onClick={handleFileUpload}
                variant="outline"
                size="sm"
                className="h-10 w-10 p-0 bg-transparent border-[1.5px] border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center justify-center cursor-pointer"
                disabled={
                  !isLoggedIn || loading || (disabled && !isAgentRunning) || isUploading
                }
              >
                {isUploading ? (
                  <KortixLoader size="small" />
                ) : (
                  <Paperclip className="h-4 w-4" strokeWidth={2} />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{isLoggedIn ? 'Attach files' : 'Please login to attach files'}</p>
          </TooltipContent>
        </Tooltip>

        <input
          type="file"
          ref={ref}
          className="hidden"
          onChange={processFileUpload}
          multiple
          accept={ALLOWED_EXTENSIONS_STRING}
        />
      </>
    );
  },
));

FileUploadHandler.displayName = 'FileUploadHandler';

export const uploadPendingFilesToProject = async (
  files: File[],
  projectId: string,
  onProgress?: (fileIndex: number, status: 'uploading' | 'ready' | 'error', error?: string) => void,
): Promise<{ success: boolean; uploadedPaths: string[] }> => {
  const uploadedPaths: string[] = [];
  let allSuccess = true;

  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('No access token available');
  }

  try {
    await fetch(`${API_URL}/project/${projectId}/files/upload-started`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_count: files.length }),
    });
  } catch (e) {
    console.warn('Failed to signal upload start:', e);
  }

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(i, 'uploading');

      try {
        if (file.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
          throw new Error(`File size exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit`);
        }

        const normalizedName = normalizeFilenameToNFC(file.name);
        const uploadPath = `/workspace/uploads/${normalizedName}`;

        const formData = new FormData();
        formData.append('file', file, normalizedName);
        formData.append('path', uploadPath);

        const response = await fetch(`${API_URL}/project/${projectId}/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        });

        if (!response.ok) {
          if (response.status === 431) {
            throw new Error('Request is too large');
          }
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        const responseData = await response.json();
        const actualPath = responseData.path || uploadPath;
        uploadedPaths.push(actualPath);
        
        onProgress?.(i, 'ready');
      } catch (error) {
        console.error(`Failed to upload file ${file.name}:`, error);
        onProgress?.(i, 'error', error instanceof Error ? error.message : 'Upload failed');
        allSuccess = false;
      }
    }
  } finally {
    try {
      await fetch(`${API_URL}/project/${projectId}/files/upload-completed`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
    } catch (e) {
      console.warn('Failed to signal upload complete:', e);
    }
  }

  return { success: allSuccess, uploadedPaths };
};

export { handleFiles, handleLocalFiles, handleLocalFilesOptimistic, uploadFiles, uploadPendingFilesToProject as uploadFilesToProjectDirect };
