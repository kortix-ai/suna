import { SERVER_URL } from '@/constants/Server';
import { createSupabaseClient } from '@/constants/SupabaseConfig';
import type { FileItem } from '@/stores/file-browser-store';

// Normalize path to ensure consistent format
export const normalizePath = (path: string): string => {
  if (!path) return '/workspace';
  
  // Ensure path starts with /workspace
  if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }
  
  // Remove duplicate slashes and normalize
  path = path.replace(/\/+/g, '/');
  
  // Remove trailing slash unless it's the root
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  
  return path;
};

// Get authenticated headers
const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const supabase = createSupabaseClient();
  const { data: { session }, error } = await supabase.auth.getSession();
  
  if (error || !session?.access_token) {
    throw new Error('Authentication required');
  }
  
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
};

// List directory contents
export const listDirectoryFiles = async (
  sandboxId: string,
  directoryPath: string = '/workspace'
): Promise<FileItem[]> => {
  const normalizedPath = normalizePath(directoryPath);
  
  console.log(`[SANDBOX-API] listDirectoryFiles called:`);
  console.log(`[SANDBOX-API] - sandboxId: ${sandboxId}`);
  console.log(`[SANDBOX-API] - directoryPath: ${directoryPath}`);
  console.log(`[SANDBOX-API] - normalizedPath: ${normalizedPath}`);
  
  try {
    const headers = await getAuthHeaders();
    console.log(`[SANDBOX-API] - auth headers obtained`);
    
    const url = new URL(`${SERVER_URL}/sandboxes/${sandboxId}/files`);
    url.searchParams.append('path', normalizedPath);
    
    console.log(`[SANDBOX-API] - request URL: ${url.toString()}`);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
    });
    
    console.log(`[SANDBOX-API] - response status: ${response.status}`);
    console.log(`[SANDBOX-API] - response ok: ${response.ok}`);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Failed to list directory');
      console.log(`[SANDBOX-API] - error response text: ${errorText}`);
      throw new Error(`Failed to list directory: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    console.log(`[SANDBOX-API] - response data type: ${typeof data}`);
    console.log(`[SANDBOX-API] - response data:`, data);
    console.log(`[SANDBOX-API] - is array: ${Array.isArray(data)}`);

    // Extract files array from response object
    const filesArray = data?.files;
    
    if (!Array.isArray(filesArray)) {
        console.log(`[SANDBOX-API] - ERROR: Expected files array, got ${typeof filesArray}`);
        throw new Error(`Expected files array in response, got ${typeof filesArray}`);
    }

    console.log(`[SANDBOX-API] - files array length: ${filesArray.length}`);
    
    // Transform API response to FileItem format
    const transformedData = filesArray.map((item: any) => {
      console.log(`[SANDBOX-API] - transforming item:`, item);
      return {
        name: item.name,
        path: item.path,
        isDirectory: item.is_dir || false,
        size: item.size,
        modifiedAt: item.mod_time,
      };
    });
    
    console.log(`[SANDBOX-API] - transformed ${transformedData.length} items`);
    console.log(`[SANDBOX-API] - first few items:`, transformedData.slice(0, 3));
    
    return transformedData;
  } catch (error) {
    console.error(`[SANDBOX-API] - Error in listDirectoryFiles:`, error);
    throw error;
  }
};

// Get file content
export const getFileContent = async (
  sandboxId: string,
  filePath: string
): Promise<string | Blob> => {
  const normalizedPath = normalizePath(filePath);
  const headers = await getAuthHeaders();
  
  const url = new URL(`${SERVER_URL}/sandboxes/${sandboxId}/files/content`);
  url.searchParams.append('path', normalizedPath);
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': headers['Authorization'],
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Failed to get file content');
    throw new Error(`Failed to get file content: ${response.status} ${errorText}`);
  }
  
  // Determine content type based on file extension
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'mp4', 'mp3'];
  
  if (binaryExtensions.includes(extension)) {
    return await response.blob();
  } else {
    return await response.text();
  }
};

// Download file
export const downloadFile = async (
  sandboxId: string,
  filePath: string
): Promise<Blob> => {
  const normalizedPath = normalizePath(filePath);
  const headers = await getAuthHeaders();
  
  const url = new URL(`${SERVER_URL}/sandboxes/${sandboxId}/files/content`);
  url.searchParams.append('path', normalizedPath);
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': headers['Authorization'],
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Failed to download file');
    throw new Error(`Failed to download file: ${response.status} ${errorText}`);
  }
  
  return await response.blob();
};

// Check if file is an image
export const isImageFile = (filePath: string): boolean => {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension);
};

// Check if file is text-based
export const isTextFile = (filePath: string): boolean => {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'py', 'java', 'cpp', 'c'].includes(extension);
};

// Get file type for display
export const getFileType = (filePath: string): 'image' | 'text' | 'binary' => {
  if (isImageFile(filePath)) return 'image';
  if (isTextFile(filePath)) return 'text';
  return 'binary';
};