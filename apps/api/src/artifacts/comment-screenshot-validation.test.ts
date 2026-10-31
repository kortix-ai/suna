import { beforeAll, expect, test } from 'bun:test';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { decodeArtifactCommentScreenshot } from './comment-screenshot-validation';

let png: Buffer;
let webp: Buffer;
beforeAll(async () => {
  const image = { create: { width: 64, height: 32, channels: 4 as const, background: '#ff0000' } };
  png = await sharp(image).png().toBuffer();
  webp = await sharp(image).webp().toBuffer();
});

test('validated PNG and WebP retain the exact original bytes and inferred MIME', async () => {
  for (const [bytes, mime, extension] of [[png, 'image/png', 'png'], [webp, 'image/webp', 'webp']] as const) {
    const decoded = await decodeArtifactCommentScreenshot(bytes.toString('base64'));
    expect([...decoded.bytes]).toEqual([...bytes]);
    expect(decoded.mime).toBe(mime);
    expect(decoded.extension).toBe(extension);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(32);
    expect((await decodeArtifactCommentScreenshot(`data:${mime};base64,${bytes.toString('base64')}`)).mime).toBe(mime);
  }
});

test('invalid base64, MIME mismatches, nonimages, and truncated images return screenshot_too_large413', async () => {
  for (const value of [null, 1, '', 'not base64', '====', png.toString('base64').slice(1), 'data:image/svg+xml;base64,PHN2Zy8+', `data:image/webp;base64,${png.toString('base64')}`, Buffer.from('<svg/>').toString('base64'), png.subarray(0, 20).toString('base64'), webp.subarray(0, 20).toString('base64')]) {
    await expect(decodeArtifactCommentScreenshot(value)).rejects.toMatchObject({ status: 413, code: 'screenshot_too_large' });
  }
});

test('the cap applies to decoded bytes of an actual valid PNG', async () => {
  const bytes = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  await expect(decodeArtifactCommentScreenshot(bytes.toString('base64'))).rejects.toMatchObject({ status: 413, code: 'screenshot_too_large' });
});

test('small compressed images cannot bypass dimension and pixel bounds', async () => {
  for (const [width, height] of [[8193, 1], [5000, 4000]]) {
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(decodeArtifactCommentScreenshot(bytes.toString('base64'))).rejects.toMatchObject({ status: 413, code: 'screenshot_too_large' });
  }
});
