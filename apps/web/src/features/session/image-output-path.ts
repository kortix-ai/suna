import { SANDBOX_FS_ROOTS } from '@/features/files/api/opencode-files';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

// Absolute image paths under any daemon-served root (/workspace, /tmp, /home, /opt)
const SANDBOX_IMAGE_PATH_RE = new RegExp(
  `(?:${SANDBOX_FS_ROOTS.join('|')})/[^\\s"']+\\.(?:png|jpe?g|gif|webp|svg|bmp|ico)`,
  'i',
);

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === 'workspace') return '/workspace';
  if (trimmed.startsWith('workspace/')) return `/${trimmed}`;
  return trimmed;
}

export interface ParsedImageOutput {
  imagePath: string | null;
  directUrl: string | null;
}

/**
 * Parse an image tool's output — a JSON payload, a bare file path, or prose
 * mentioning a path — into a sandbox image path and/or a direct https URL.
 */
export function parseImageOutput(output: string | null | undefined): ParsedImageOutput {
  if (!output) return { imagePath: null, directUrl: null };
  const trimmed = output.trim();

  // 1. JSON payload with a path/url field
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const p = parsed.path || parsed.image_path || parsed.output_path || null;
      const url = parsed.replicate_url || parsed.url || parsed.image_url || null;
      return {
        imagePath: p ? String(p).trim() : null,
        directUrl: url ? String(url).trim() : null,
      };
    }
  } catch {
    // not JSON
  }

  // 2. Output itself is a (possibly quoted) file path
  const cleaned = trimmed.replace(/^["']+|["']+$/g, '').trim();
  if (IMAGE_EXT_RE.test(cleaned)) {
    return { imagePath: normalizeWorkspacePath(cleaned), directUrl: null };
  }

  // 3. Extract a sandbox path from surrounding text
  const extractedPath = trimmed.match(SANDBOX_IMAGE_PATH_RE);
  return { imagePath: extractedPath?.[0] ?? null, directUrl: null };
}
