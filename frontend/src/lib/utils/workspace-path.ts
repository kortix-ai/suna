/**
 * Shared utility for normalizing workspace paths.
 * 
 * ARCHITECTURE:
 * - /workspace/ is ALWAYS the base directory for all files
 * - File paths for backend API calls use: /workspace/relativePath
 * - Sandbox proxy URLs use: ${sandboxUrl}/${threadId}/relativePath
 * 
 * This module handles FILE PATHS only (for backend API calls).
 * For sandbox proxy URLs, use constructSandboxPreviewUrl from url.ts
 */

/**
 * Get threadId from the current page URL.
 * Used for constructing sandbox proxy URLs.
 */
export function getThreadIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  
  // Extract threadId from URL pattern: /projects/[projectId]/thread/[threadId]
  const match = window.location.pathname.match(/\/projects\/[^/]+\/thread\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Normalize a file path to ensure it starts with /workspace
 * 
 * This is for BACKEND API CALLS - files are always at /workspace/...
 * NO thread ID is included in file paths.
 * 
 * Handles paths like:
 * - "workspace" -> "/workspace"
 * - "workspace/foo" -> "/workspace/foo"
 * - "/workspace" -> "/workspace"
 * - "/workspace/foo" -> "/workspace/foo"
 * - "/foo" -> "/workspace/foo"
 * - "foo" -> "/workspace/foo"
 * - "/workspace/{uuid}/foo" -> "/workspace/foo" (strips embedded thread IDs)
 * 
 * @param path - The file path to normalize
 * @returns Normalized path starting with /workspace/
 */
export function normalizeWorkspacePath(path: string): string {
  if (!path) {
    return '/workspace';
  }
  
  // Handle paths that start with "workspace" (without leading /)
  if (path === 'workspace' || path.startsWith('workspace/')) {
    path = '/' + path;
  }
  
  // If path starts with /workspace, check for embedded thread ID and strip it
  if (path.startsWith('/workspace/')) {
    const afterWorkspace = path.slice('/workspace/'.length);
    const segments = afterWorkspace.split('/').filter(Boolean);
    
    // UUID pattern: 8-4-4-4-12 hex characters
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    // If first segment looks like a UUID (thread ID), strip it
    if (segments.length > 0 && uuidPattern.test(segments[0])) {
      segments.shift();
      return segments.length > 0 ? `/workspace/${segments.join('/')}` : '/workspace';
    }
    
    // No thread ID found, return as-is
    return path;
  }
  
  // Path is /workspace exactly
  if (path === '/workspace') {
    return path;
  }
  
  // Relative path - prepend /workspace/
  return `/workspace/${path.replace(/^\//, '')}`;
}

/**
 * Get the relative path from a workspace path (strips /workspace/ prefix)
 * 
 * @param path - Full path (e.g., /workspace/foo/bar.html)
 * @returns Relative path (e.g., foo/bar.html)
 */
export function getRelativeWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  // Remove /workspace/ prefix
  return normalized.replace(/^\/workspace\/?/, '') || '';
}
