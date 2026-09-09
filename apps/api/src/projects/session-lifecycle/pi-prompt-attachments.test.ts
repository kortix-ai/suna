import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { preparePiPromptAttachments } from './pi-prompt-attachments';

const bytes = Buffer.from('image bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const image = {
  type: 'file' as const,
  mime: 'image/png',
  filename: 'diagram.png',
  url: `data:image/png;base64,${bytes.toString('base64')}`,
};

test('staged Pi images become ordered immutable references and exact storage bytes', async () => {
  const result = await preparePiPromptAttachments([
    { type: 'text', text: 'Describe it' },
    image,
    { ...image, filename: 'copy.png' },
  ]);
  expect(result.parts).toEqual([
    { type: 'text', text: 'Describe it' },
    { ...image, url: `kortix-attachment:sha256:${sha256}` },
    {
      ...image,
      filename: 'copy.png',
      url: `kortix-attachment:sha256:${sha256}`,
    },
  ]);
  expect(result.attachments).toEqual([{ sha256, contentType: 'image/png', content: bytes }]);
  expect(JSON.stringify(result.parts)).not.toContain('data:');
});

test('existing immutable references remain valid only for an existing session', async () => {
  const reference = { ...image, url: `kortix-attachment:sha256:${sha256}` };
  expect(await preparePiPromptAttachments([reference], { allowReferences: true })).toEqual({
    parts: [reference],
    attachments: [],
  });
  await expect(preparePiPromptAttachments([reference])).rejects.toThrow(/upload.*new session/i);
});

test.each([
  { ...image, url: 'http://example.test/image.png' },
  { ...image, url: 'file:///workspace/image.png' },
  { ...image, mime: 'image/svg+xml' },
  { ...image, mime: 'application/pdf' },
  { ...image, source: { path: '/workspace/secret' } },
  { ...image, filename: 'a'.repeat(256) },
  { ...image, filename: 'a\0.png' },
  { ...image, url: 'data:image/jpeg;base64,AQID' },
  { ...image, url: 'data:image/png;base64,AQ!D' },
  { ...image, url: 'data:image/png;base64,' },
  { type: 'agent' as const, name: 'other-agent' },
])('refuses unsupported or malformed parts before any bytes are stored %#', async (part) => {
  await expect(preparePiPromptAttachments([image, part])).rejects.toThrow();
});

test('one image is limited to 8 MiB and one prompt to 16 images', async () => {
  const maximum = {
    ...image,
    url: `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024).toString('base64')}`,
  };
  expect((await preparePiPromptAttachments([maximum])).attachments[0]?.content.length).toBe(
    8 * 1024 * 1024,
  );
  const oversized = {
    ...image,
    url: `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')}`,
  };
  await expect(preparePiPromptAttachments([oversized])).rejects.toThrow(/8 MiB/);
  expect(
    (await preparePiPromptAttachments(Array.from({ length: 16 }, () => image))).parts,
  ).toHaveLength(16);
  await expect(preparePiPromptAttachments(Array.from({ length: 17 }, () => image))).rejects.toThrow(
    /16 images/,
  );
});

test('the same bytes cannot acquire two MIME types within one batch', async () => {
  await expect(
    preparePiPromptAttachments([
      image,
      {
        ...image,
        mime: 'image/jpeg',
        url: image.url.replace('image/png', 'image/jpeg'),
      },
    ]),
  ).rejects.toThrow(/MIME/);
});
