/**
 * HEIC/HEIF → JPEG conversion.
 * The CSP-safe decoder is lazy-loaded; production never permits unsafe-eval.
 */

const HEIC_EXT = new Set(['heic', 'heif']);

export function isHeicFile(filename: string): boolean {
  return HEIC_EXT.has(filename.split('.').pop()?.toLowerCase() || '');
}

export async function convertHeicBlobToJpeg(blob: Blob): Promise<Blob> {
  const { heicTo } = await import('heic-to/csp');
  return heicTo({ blob, type: 'image/jpeg', quality: 0.92 });
}
