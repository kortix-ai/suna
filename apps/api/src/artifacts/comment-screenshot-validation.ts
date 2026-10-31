import sharp from 'sharp';

export const ARTIFACT_SCREENSHOT_LIMITS = {
  bytes: 2 * 1024 * 1024,
  dimension: 8192,
  pixels: 16_777_216,
  processingSeconds: 2,
  deadlineMs: 5000,
} as const;

export class ArtifactCommentScreenshotError extends Error {
  constructor(readonly status: 404 | 413 | 503, readonly code: string, message: string, readonly limits?: { max_files: number; max_total_bytes: number; max_screenshot_bytes: number; max_parts_bytes?: number }) {
    super(message);
    this.name = 'ArtifactCommentScreenshotError';
  }
}
const invalid = () => new ArtifactCommentScreenshotError(413, 'screenshot_too_large', 'Screenshot must be a valid PNG or WebP image of at most 2 MiB.');

export interface ArtifactCommentScreenshot {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/webp';
  extension: 'png' | 'webp';
  width: number;
  height: number;
}

export async function decodeArtifactCommentScreenshot(value: unknown): Promise<ArtifactCommentScreenshot> {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(ARTIFACT_SCREENSHOT_LIMITS.bytes / 3) * 4 + 40) throw invalid();
  let encoded = value;
  let declared: string | undefined;
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if (!match) throw invalid();
    declared = match[1];
    encoded = match[2]!;
  }
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.byteLength || bytes.byteLength > ARTIFACT_SCREENSHOT_LIMITS.bytes || bytes.toString('base64') !== encoded) throw invalid();
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8;
  const mime: 'image/png' | 'image/webp' | null = png ? 'image/png' : webp ? 'image/webp' : null;
  if (!mime || declared && declared !== mime) throw invalid();
  let image: ReturnType<typeof sharp> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image = sharp(bytes, { failOn: 'warning', limitInputPixels: ARTIFACT_SCREENSHOT_LIMITS.pixels }).timeout({ seconds: ARTIFACT_SCREENSHOT_LIMITS.processingSeconds });
    const decode = async (): Promise<ArtifactCommentScreenshot> => {
      const metadata = await image!.metadata();
      if (metadata.format !== (png ? 'png' : 'webp') || !metadata.width || !metadata.height || metadata.width > ARTIFACT_SCREENSHOT_LIMITS.dimension || metadata.height > ARTIFACT_SCREENSHOT_LIMITS.dimension || metadata.width * metadata.height > ARTIFACT_SCREENSHOT_LIMITS.pixels || (metadata.pages ?? 1) !== 1) throw invalid();
      await image!.stats();
      return { bytes, mime, extension: png ? 'png' as const : 'webp' as const, width: metadata.width, height: metadata.height };
    };
    return await Promise.race([
      decode(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { image?.destroy(); reject(invalid()); }, ARTIFACT_SCREENSHOT_LIMITS.deadlineMs); }),
    ]);
  } catch {
    throw invalid();
  } finally {
    if (timer) clearTimeout(timer);
    image?.destroy();
  }
}
