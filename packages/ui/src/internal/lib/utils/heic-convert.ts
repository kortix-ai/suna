/**
 * HEIC/HEIF → JPEG conversion.
 * heic2any is lazy-loaded — zero bundle cost when no HEIC files are opened.
 */

const HEIC_EXT = new Set(['heic', 'heif']);

export function isHeicFile(filename: string): boolean {
  return HEIC_EXT.has(filename.split('.').pop()?.toLowerCase() || '');
}

export async function convertHeicBlobToJpeg(blob: Blob): Promise<Blob> {
  const heic2any = (await import('heic2any')).default;
  const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(result) ? result[0] : result;
}
