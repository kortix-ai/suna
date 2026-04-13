import { rewriteLocalhostUrl, type SubdomainUrlOptions } from '@/lib/utils/sandbox-url';
import { SANDBOX_PORTS } from '@/lib/platform-client';

/**
 * Build a proxied URL for a file served by the static web server (port 3211).
 *
 * The static-web server (port 3211) serves workspace files via:
 *   http://localhost:3211/open?path=/workspace/{filePath}
 *
 * Rewritten through the sandbox preview proxy to either:
 *   - subdomain:  http://p3211-{sandboxId}.localhost:{backendPort}/open?path=/workspace/{filePath}
 *   - path-based: {apiBaseUrl}/p/{sandboxId}/3211/open?path=/workspace/{filePath}
 *
 * Same pattern used for Desktop (port 6080) and Browser Viewer (port 9224).
 */
export function constructHtmlPreviewUrl(
  filePath: string | undefined,
  subdomainOpts: SubdomainUrlOptions,
): string | undefined {
  if (!filePath) return undefined;

  // Normalize the file path: strip leading /workspace/ prefix if present
  const processedPath = filePath.replace(/^\/workspace\//, '');

  // Split the path into segments and encode each segment individually
  const pathSegments = processedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));

  const encodedPath = pathSegments.join('/');

  const port = parseInt(SANDBOX_PORTS.STATIC_FILE_SERVER ?? '3211', 10);
  const staticPath = `/open?path=/workspace/${encodedPath}`;
  return rewriteLocalhostUrl(port, staticPath, subdomainOpts);
}
