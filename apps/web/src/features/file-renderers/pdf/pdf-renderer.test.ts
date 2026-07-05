import { describe, expect, test } from 'bun:test';
import { base64PdfContentToBlob } from './pdf-renderer';

describe('base64PdfContentToBlob', () => {
  test('decodes base64 PDF content into an application/pdf blob', async () => {
    const blob = base64PdfContentToBlob('JVBERi0xLjQK');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(blob.type).toBe('application/pdf');
    expect(Array.from(bytes)).toEqual([37, 80, 68, 70, 45, 49, 46, 52, 10]);
  });
});
