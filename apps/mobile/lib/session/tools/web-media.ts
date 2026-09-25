/**
 * Pure logic behind the media tool renderers: `image-search-tool.tsx`,
 * `image-gen-tool.tsx`, `video-gen-tool.tsx`, `presentation-gen-tool.tsx`.
 *
 * Ported from apps/web:
 * - `tool/tools/image-search-tool.tsx` output parsing, tiles, badge;
 * - `features/session/image-output-path.ts` `parseImageOutput`;
 * - `tool/tools/image-gen-tool.tsx` `TITLE_BY_ACTION`;
 * - `tool/tools/presentation-gen-tool.tsx` labels, subtitle, success-line set.
 *
 * `parseVideoOutput` is mobile-only: web prints the video tool's output as a
 * text block; mobile also finds the video so the card can open it.
 */

import { SANDBOX_FS_ROOTS } from '@kortix/sdk';
import { safeHttpUrl } from './web-fetch';

// ─── Image search ────────────────────────────────────────────────────────────

export interface ImageSearchParsed {
  imageResults: any[];
  isBatch: boolean;
  batchCount: number;
  displayQuery: string;
}

export function parseImageSearchOutput(output: string, query: string): ImageSearchParsed {
  const empty = { imageResults: [], isBatch: false, batchCount: 0, displayQuery: query };
  if (!output) return empty;
  try {
    const parsed = JSON.parse(output);

    if (parsed.batch_mode === true && Array.isArray(parsed.results)) {
      const allImages = parsed.results.flatMap((r: any) => (Array.isArray(r.images) ? r.images : []));
      const queries = parsed.results.map((r: any) => r.query).filter(Boolean);
      return {
        imageResults: allImages,
        isBatch: true,
        batchCount: parsed.results.length,
        displayQuery: queries.length > 1 ? `${queries.length} queries` : queries[0] || query,
      };
    }

    if (parsed.batch_results && Array.isArray(parsed.batch_results)) {
      const allImages = parsed.batch_results.flatMap((r: any) => (Array.isArray(r.images) ? r.images : []));
      return { imageResults: allImages, isBatch: true, batchCount: parsed.batch_results.length, displayQuery: query };
    }

    if (Array.isArray(parsed)) return { ...empty, imageResults: parsed };
    if (parsed.images && Array.isArray(parsed.images)) return { ...empty, imageResults: parsed.images };
    if (parsed.results && Array.isArray(parsed.results)) return { ...empty, imageResults: parsed.results };
  } catch {
    // not JSON
  }
  return empty;
}

/** "2q, 12 images" — absent with no images. */
export function imageSearchBadge(parsed: ImageSearchParsed): string | undefined {
  if (parsed.imageResults.length === 0) return undefined;
  return `${parsed.isBatch ? `${parsed.batchCount}q, ` : ''}${parsed.imageResults.length} images`;
}

/** The first 9 results, keeping only safe http(s) image URLs. */
export function imageSearchTiles(imageResults: any[]): Array<{ url: string; title: string }> {
  const tiles: Array<{ url: string; title: string }> = [];
  for (const img of imageResults.slice(0, 9)) {
    const url = safeHttpUrl(img?.url || img?.imageUrl || img?.image_url || '');
    if (!url) continue;
    tiles.push({ url, title: typeof img?.title === 'string' ? img.title : '' });
  }
  return tiles;
}

// ─── Image / video output paths ──────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const SANDBOX_IMAGE_PATH_RE = new RegExp(
  `(?:${SANDBOX_FS_ROOTS.join('|')})/[^\\s"']+\\.(?:png|jpe?g|gif|webp|svg|bmp|ico)`,
  'i',
);
const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i;
const SANDBOX_VIDEO_PATH_RE = new RegExp(
  `(?:${SANDBOX_FS_ROOTS.join('|')})/[^\\s"']+\\.(?:mp4|webm|mov|avi|mkv|m4v|ogv)`,
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

/** An image tool's output → a sandbox image path and/or a direct URL. */
export function parseImageOutput(output: string | null | undefined): ParsedImageOutput {
  if (!output) return { imagePath: null, directUrl: null };
  const trimmed = output.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const p = parsed.path || parsed.image_path || parsed.output_path || null;
      const url = parsed.replicate_url || parsed.url || parsed.image_url || null;
      return { imagePath: p ? String(p).trim() : null, directUrl: url ? String(url).trim() : null };
    }
  } catch {
    // not JSON
  }

  const cleaned = trimmed.replace(/^["']+|["']+$/g, '').trim();
  if (IMAGE_EXT_RE.test(cleaned)) return { imagePath: normalizeWorkspacePath(cleaned), directUrl: null };

  const extractedPath = trimmed.match(SANDBOX_IMAGE_PATH_RE);
  return { imagePath: extractedPath?.[0] ?? null, directUrl: null };
}

export interface ParsedVideoOutput {
  videoPath: string | null;
  directUrl: string | null;
}

/** A video tool's output → a sandbox video path and/or a direct http(s) URL. */
export function parseVideoOutput(output: string | null | undefined): ParsedVideoOutput {
  if (!output) return { videoPath: null, directUrl: null };
  const trimmed = output.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const p = parsed.path || parsed.video_path || parsed.output_path || null;
      const url = parsed.replicate_url || parsed.url || parsed.video_url || null;
      return { videoPath: p ? String(p).trim() : null, directUrl: safeHttpUrl(url) };
    }
  } catch {
    // not JSON
  }

  const cleaned = trimmed.replace(/^["']+|["']+$/g, '').trim();
  if (VIDEO_EXT_RE.test(cleaned) && !/\s/.test(cleaned)) {
    const direct = safeHttpUrl(cleaned);
    return direct ? { videoPath: null, directUrl: direct } : { videoPath: normalizeWorkspacePath(cleaned), directUrl: null };
  }

  const extractedPath = trimmed.match(SANDBOX_VIDEO_PATH_RE);
  return { videoPath: extractedPath?.[0] ?? null, directUrl: null };
}

// ─── Image gen ───────────────────────────────────────────────────────────────

const IMAGE_GEN_TITLE_BY_ACTION: Record<string, string> = {
  generate: 'Generate Image',
  edit: 'Edit Image',
  upscale: 'Upscale Image',
  remove_bg: 'Remove Background',
};

export function imageGenTitle(action: string | undefined): string {
  return IMAGE_GEN_TITLE_BY_ACTION[action ?? ''] || 'Image Gen';
}

// ─── Presentation gen ────────────────────────────────────────────────────────

const PRESENTATION_ACTION_LABELS: Record<string, string> = {
  create_slide: 'Create Slide',
  list_slides: 'List Slides',
  delete_slide: 'Delete Slide',
  list_presentations: 'List',
  delete_presentation: 'Delete',
  validate_slide: 'Validate',
  export_pdf: 'Export PDF',
  export_pptx: 'Export PPTX',
  preview: 'Preview',
  serve: 'Serve',
};

const ACTIONS_WITH_OWN_SUCCESS_LINE = new Set([
  'create_slide',
  'validate_slide',
  'preview',
  'serve',
  'export_pdf',
  'export_pptx',
]);

export function presentationActionLabel(action: string | undefined): string | undefined {
  return PRESENTATION_ACTION_LABELS[action ?? ''] || action;
}

export function presentationHasOwnSuccessLine(action: string | undefined): boolean {
  return ACTIONS_WITH_OWN_SUCCESS_LINE.has(action ?? '');
}

export function presentationTriggerSubtitle({
  action,
  presentationName,
  slideTitle,
  slideNumber,
}: {
  action?: string;
  presentationName?: string;
  slideTitle?: string;
  slideNumber?: number | string;
}): string | undefined {
  if (action === 'create_slide' && slideTitle) return `Slide ${slideNumber || '?'}: ${slideTitle}`;
  if (action === 'preview' || action === 'serve') return presentationName;
  if (action === 'export_pdf') return `${presentationName} → PDF`;
  if (action === 'export_pptx') return `${presentationName} → PPTX`;
  if (action === 'list_slides') return presentationName;
  if (action === 'list_presentations') return 'All presentations';
  if (action === 'delete_slide' || action === 'delete_presentation') return presentationName;
  if (action === 'validate_slide') return `Slide ${slideNumber || '?'}`;
  return presentationName || action;
}
