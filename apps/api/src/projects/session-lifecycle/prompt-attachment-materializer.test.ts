import { describe, expect, test } from 'bun:test';

import type { PromptPartWire } from './store';
import {
  PromptAttachmentMaterializationError,
  materializePromptAttachments,
} from './prompt-attachment-materializer';

const parts: PromptPartWire[] = [
  { type: 'text', text: 'Inspect these files.' },
  {
    type: 'file',
    mime: 'application/zip',
    filename: 'bundle.zip',
    url: 'data:application/zip;base64,UEsDBA==',
  },
  {
    type: 'file',
    mime: 'image/png',
    filename: 'shot.png',
    url: 'data:image/png;base64,iVBORw0KGgo=',
  },
  {
    type: 'file',
    mime: 'text/markdown',
    filename: 'README.md',
    url: 'data:text/markdown;base64,IyBSZWFkbWU=',
  },
];

function materialize(input: Partial<Parameters<typeof materializePromptAttachments>[0]> = {}) {
  return materializePromptAttachments({
    parts,
    externalId: 'sbx_1',
    sessionId: 'session_1',
    userId: 'user_1',
    materializationKey: 'command_1',
    writeFile: async (file) => ({ path: file.targetPath, size: file.bytes.byteLength }),
    ...input,
  });
}

describe('materializePromptAttachments', () => {
  test('materializes non-native files while preserving native parts and order', async () => {
    const writes: string[] = [];
    const result = await materialize({
      writeFile: async (input) => {
        writes.push(input.targetPath);
        return { path: input.targetPath, size: input.bytes.byteLength };
      },
    });

    expect(writes).toEqual([
      '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
      '/workspace/uploads/.kortix-inbox/command_1/3-README.md',
    ]);
    expect(result[0]).toEqual(parts[0]);
    expect(result[1]).toMatchObject({ type: 'text' });
    expect(result[2]).toEqual(parts[2]);
    expect(result[3]).toMatchObject({ type: 'text' });
    expect(result[1]?.text).toContain('filename="bundle.zip"');
    expect(result[3]?.text).toContain('filename="README.md"');
  });

  test('waits for every file and reports every failed filename', async () => {
    const error = await materialize({
      writeFile: async ({ filename }) => {
        throw new Error(`cannot write ${filename}`);
      },
    }).catch((value) => value);

    expect(error).toBeInstanceOf(PromptAttachmentMaterializationError);
    expect(error.failures.map((failure: { filename: string }) => failure.filename)).toEqual([
      'bundle.zip',
      'README.md',
    ]);
  });

  test('rejects malformed staged data without forwarding a partial prompt', async () => {
    const error = await materialize({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,%%%=',
        },
        {
          type: 'file',
          mime: 'text/markdown',
          filename: 'README.md',
          url: 'data:text/markdown;base64,IyBSZWFkbWU=',
        },
      ],
    }).catch((value) => value);

    expect(error).toBeInstanceOf(PromptAttachmentMaterializationError);
    expect(error.failures).toEqual([
      { filename: 'bundle.zip', reason: 'file "bundle.zip" has malformed staged data' },
    ]);
  });

  test('rejects mismatched MIME metadata', async () => {
    const error = await materialize({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:text/plain;base64,UEsDBA==',
        },
      ],
    }).catch((value) => value);

    expect(error).toBeInstanceOf(PromptAttachmentMaterializationError);
    expect(error.failures).toEqual([
      { filename: 'bundle.zip', reason: 'file "bundle.zip" has inconsistent MIME metadata' },
    ]);
  });

  test('uses index-prefixed paths for duplicate filenames', async () => {
    const paths: string[] = [];
    await materialize({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
      writeFile: async (input) => {
        paths.push(input.targetPath);
        return { path: input.targetPath, size: input.bytes.byteLength };
      },
    });

    expect(paths).toEqual([
      '/workspace/uploads/.kortix-inbox/command_1/0-bundle.zip',
      '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
    ]);
  });

  test('turns attachment-only input into file reference parts', async () => {
    const result = await materialize({
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
        {
          type: 'file',
          mime: 'text/markdown',
          filename: 'README.md',
          url: 'data:text/markdown;base64,IyBSZWFkbWU=',
        },
      ],
    });

    expect(result).toMatchObject([
      { type: 'text', text: expect.stringContaining('filename="bundle.zip"') },
      { type: 'text', text: expect.stringContaining('filename="README.md"') },
    ]);
  });
});
