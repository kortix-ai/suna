import { getThreadIdFromUrl, getRelativeWorkspacePath } from './workspace-path';

/**
 * Constructs a preview URL for files in the sandbox proxy.
 * 
 * ARCHITECTURE:
 * - Sandbox proxy URLs use: ${sandboxUrl}/${threadId}/${relativePath}
 * - The threadId is for routing in the sandbox proxy
 * - relativePath is the path relative to /workspace/
 * 
 * @param sandboxUrl - The base URL of the sandbox (e.g., https://8080-xxx.proxy.daytona.works)
 * @param filePath - The path to the file. Can be:
 *   - Relative path: "file.html" -> uses current thread ID
 *   - Workspace path: "/workspace/file.html" -> extracts relative path
 *   - Full API URL: extracts path parameter
 * @param threadId - Optional thread ID. If not provided, extracted from current page URL.
 * @returns The properly encoded preview URL, or undefined if inputs are invalid
 */
export function constructHtmlPreviewUrl(
  sandboxUrl: string | undefined,
  filePath: string | undefined,
  threadId?: string | null,
): string | undefined {
  if (!sandboxUrl || !filePath) {
    return undefined;
  }

  let relativePath = filePath;

  // If filePath is a full URL (API endpoint), extract the path parameter
  if (filePath.includes('://') || filePath.includes('/sandboxes/') || filePath.includes('/files/content')) {
    try {
      // Try to parse as URL if it's a full URL
      if (filePath.includes('://')) {
        const url = new URL(filePath);
        const pathParam = url.searchParams.get('path');
        if (pathParam) {
          relativePath = decodeURIComponent(pathParam);
        } else {
          const pathMatch = filePath.match(/[?&]path=([^&]+)/);
          if (pathMatch) {
            relativePath = decodeURIComponent(pathMatch[1]);
          } else {
            return undefined;
          }
        }
      } else {
        // Relative URL pattern: /sandboxes/.../files/content?path=...
        const pathMatch = filePath.match(/[?&]path=([^&]+)/);
        if (pathMatch) {
          relativePath = decodeURIComponent(pathMatch[1]);
        } else {
          return undefined;
        }
      }
    } catch (e) {
      console.warn('Failed to parse filePath as URL, treating as regular path:', filePath);
    }
  }

  // Convert to relative path (strips /workspace/ prefix and any embedded thread ID)
  relativePath = getRelativeWorkspacePath(relativePath);

  // Get thread ID: provided > from URL
  const finalThreadId = threadId ?? (typeof window !== 'undefined' ? getThreadIdFromUrl() : null);

  // Split the path into segments and encode each segment individually
  const pathSegments = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));

  const encodedPath = pathSegments.join('/');

  // Clean sandbox URL (remove trailing slash)
  const cleanSandboxUrl = sandboxUrl.replace(/\/$/, '');

  // Construct URL with thread ID if available
  if (finalThreadId && encodedPath) {
    return `${cleanSandboxUrl}/${finalThreadId}/${encodedPath}`;
  } else if (finalThreadId) {
    return `${cleanSandboxUrl}/${finalThreadId}`;
  } else if (encodedPath) {
    return `${cleanSandboxUrl}/${encodedPath}`;
  }

  return cleanSandboxUrl;
}

/**
 * Alias for constructHtmlPreviewUrl for semantic clarity.
 * Use this when constructing any sandbox preview URL (not just HTML).
 */
export const constructSandboxPreviewUrl = constructHtmlPreviewUrl;
