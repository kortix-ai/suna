/**
 * Shared utility for normalizing workspace paths with thread_id support
 */

/**
 * Get threadId from URL params
 */
export function getThreadIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  
  // Extract threadId from URL pattern: /projects/[projectId]/thread/[threadId]
  const match = window.location.pathname.match(/\/projects\/[^/]+\/thread\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Normalize a file path to ensure it starts with /workspace
 * Handles paths like "workspace", "workspace/foo", "/workspace", "/workspace/foo", "/foo", "foo"
 * 
 * IMPORTANT: /workspace is always accessible as the root. Thread-specific paths are optional
 * subdirectories under /workspace (e.g., /workspace/{thread_id}).
 * 
 * For relative paths, this function returns the root workspace path. The caller should handle
 * fallback to thread-specific paths if needed (e.g., in fetchFileContent).
 * 
 * @param path - The file path to normalize
 * @param threadId - Optional threadId (will be extracted from URL if not provided)
 * @param preferThreadWorkspace - If true, relative paths will use thread-specific workspace (default: false for file reads)
 * @returns Normalized path
 */
export function normalizeWorkspacePath(
  path: string, 
  threadId?: string | null,
  preferThreadWorkspace: boolean = false
): string {
  if (!path) {
    // Default to root /workspace - user can navigate to thread-specific folder if needed
    return '/workspace';
  }
  
  // Handle paths that start with "workspace" (without leading /)
  // This prevents "/workspace/workspace" when someone passes "workspace" or "workspace/foo"
  if (path === 'workspace' || path.startsWith('workspace/')) {
    return '/' + path;
  }
  
  // If path explicitly starts with /workspace, preserve it as-is
  // This allows access to root /workspace and all its subdirectories
  if (path.startsWith('/workspace')) {
    return path;
  }
  
  // For relative paths, default to root /workspace (not thread-specific)
  // This ensures files in /workspace are found first
  // Callers can try thread-specific paths as fallback if needed
  const tid = preferThreadWorkspace ? (threadId ?? getThreadIdFromUrl()) : null;
  
  if (tid) {
    return `/workspace/${tid}/${path.replace(/^\//, '')}`;
  }
  
  // No thread_id or preferThreadWorkspace is false, use root /workspace
  return `/workspace/${path.replace(/^\//, '')}`;
}

