import { describe, expect, test } from 'bun:test';

import type { PromptPartWire } from './store';
import {
  INLINE_PROMPT_BUDGET_BYTES,
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
  // A model-native attachment is only worth inlining if the prompt body can
  // still reach the box. Past the budget it is written to the workspace like
  // any other file — a JPEG the runtime never receives is worth less than a
  // JPEG the agent can open. Measured ceiling: ~104 KB lands, ~115 KB does not.
  test('materializes a native image too large to inline', async () => {
    const big = 'A'.repeat(INLINE_PROMPT_BUDGET_BYTES + 1_000);
    const writes: string[] = [];
    const result = await materializePromptAttachments({
      parts: [
        { type: 'text', text: 'look' },
        {
          type: 'file',
          mime: 'image/jpeg',
          filename: 'photo.jpg',
          url: `data:image/jpeg;base64,${big}`,
        },
      ],
      externalId: 'sbx_1',
      sessionId: 'session_1',
      userId: 'user_1',
      materializationKey: 'command_1',
      writeFile: async (file) => {
        writes.push(file.targetPath);
        return { path: file.targetPath, size: file.bytes.byteLength };
      },
    });

    expect(writes).toEqual(['/workspace/uploads/.kortix-inbox/command_1/1-photo.jpg']);
    expect(result[1]).toMatchObject({ type: 'text' });
    expect((result[1] as { text: string }).text).toContain('filename="photo.jpg"');
  });

  // Several small natives together can bust the same ceiling one big one does,
  // so the budget is spent across the whole prompt, not per attachment.
  test('spends one inline budget across the whole prompt', async () => {
    // A multiple of 4, or it is not decodable base64 and the parser rejects it
    // before the budget ever gets a say.
    const half = 'A'.repeat(Math.floor((INLINE_PROMPT_BUDGET_BYTES * 0.6) / 4) * 4);
    const png = (name: string) => ({
      type: 'file' as const,
      mime: 'image/png',
      filename: name,
      url: `data:image/png;base64,${half}`,
    });
    const writes: string[] = [];
    const result = await materializePromptAttachments({
      parts: [{ type: 'text', text: 'two shots' }, png('a.png'), png('b.png')],
      externalId: 'sbx_1',
      sessionId: 'session_1',
      userId: 'user_1',
      materializationKey: 'command_1',
      writeFile: async (file) => {
        writes.push(file.targetPath);
        return { path: file.targetPath, size: file.bytes.byteLength };
      },
    });

    // The first fits and stays native; the second would bust the budget.
    expect(result[1]).toMatchObject({ type: 'file', mime: 'image/png' });
    expect(result[2]).toMatchObject({ type: 'text' });
    expect(writes).toEqual(['/workspace/uploads/.kortix-inbox/command_1/2-b.png']);
  });

  // The 2026-09-04 incident, at the seam that decides it. An SVG left inline
  // reaches OpenCode as an image part, fails to decode, and takes the prompt
  // text and every sibling attachment down with it — while the inbox row still
  // says `delivered`. It must be WRITTEN to the box and referenced instead.
  test('materializes image types the model cannot decode', async () => {
    const undecodable: PromptPartWire[] = [
      { type: 'text', text: 'HII' },
      {
        type: 'file',
        mime: 'image/svg+xml',
        filename: 'Jay Suthar.svg',
        url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      },
      {
        type: 'file',
        mime: 'image/heic',
        filename: 'photo.heic',
        url: 'data:image/heic;base64,AAAA',
      },
      {
        type: 'file',
        mime: 'application/pdf',
        filename: 'Account Settings.pdf',
        url: 'data:application/pdf;base64,JVBERi0=',
      },
    ];
    const writes: string[] = [];
    const result = await materializePromptAttachments({
      parts: undecodable,
      externalId: 'sbx_1',
      sessionId: 'session_1',
      userId: 'user_1',
      materializationKey: 'command_1',
      writeFile: async (input) => {
        writes.push(input.targetPath);
        return { path: input.targetPath, size: input.bytes.byteLength };
      },
    });

    expect(writes).toEqual([
      '/workspace/uploads/.kortix-inbox/command_1/1-Jay Suthar.svg',
      '/workspace/uploads/.kortix-inbox/command_1/2-photo.heic',
    ]);
    // The text survives, the SVG and HEIC become readable file references,
    // and the PDF stays native — it decodes fine.
    expect(result[0]).toEqual(undecodable[0]);
    expect(result[1]).toMatchObject({ type: 'text' });
    expect((result[1] as { text: string }).text).toContain('mime="image/svg+xml"');
    expect((result[1] as { text: string }).text).toContain('filename="Jay Suthar.svg"');
    expect(result[2]).toMatchObject({ type: 'text' });
    expect(result[3]).toEqual(undecodable[3]);
  });

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

describe('materializePromptAttachments — review findings 2026-09-05', () => {
  const base = {
    externalId: 'sbx_1',
    sessionId: 'session_1',
    userId: 'user_1',
    materializationKey: 'command_1',
  };
  const png = (n: number) => ({
    type: 'file' as const,
    mime: 'image/png',
    filename: 'shot.png',
    url: `data:image/png;base64,${'A'.repeat(Math.floor(n / 4) * 4)}`,
  });

  test('prompt text spends the same inline budget as the files', async () => {
    const writes: string[] = [];
    const longText = 'x'.repeat(INLINE_PROMPT_BUDGET_BYTES - 1000);
    // Alone this image fits; beside a long prompt it does not.
    const result = await materializePromptAttachments({
      ...base,
      parts: [{ type: 'text', text: longText }, png(4000)],
      writeFile: async (f) => {
        writes.push(f.targetPath);
        return { path: f.targetPath, size: f.bytes.byteLength };
      },
    });
    expect(writes).toHaveLength(1);
    expect(result[1]).toMatchObject({ type: 'text' });
  });

  test('a native file that is a remote URL stays inline whatever the budget', async () => {
    const writes: string[] = [];
    const result = await materializePromptAttachments({
      ...base,
      inlineBudgetBytes: 10,
      parts: [
        { type: 'text', text: 'see' },
        { type: 'file', mime: 'image/png', filename: 'in-box.png', url: 'https://box.test/uploads/in-box.png' },
      ],
      writeFile: async (f) => {
        writes.push(f.targetPath);
        return { path: f.targetPath, size: f.bytes.byteLength };
      },
    });
    expect(writes).toEqual([]);
    expect(result[1]).toMatchObject({ type: 'file', url: 'https://box.test/uploads/in-box.png' });
  });

  test('the legacy repair keeps native images inline via an unbounded budget', async () => {
    const writes: string[] = [];
    await materializePromptAttachments({
      ...base,
      inlineBudgetBytes: Number.POSITIVE_INFINITY,
      parts: [
        png(INLINE_PROMPT_BUDGET_BYTES * 4),
        { type: 'file', mime: 'application/zip', filename: 'b.zip', url: 'data:application/zip;base64,UEsDBA==' },
      ],
      writeFile: async (f) => {
        writes.push(f.filename);
        return { path: f.targetPath, size: f.bytes.byteLength };
      },
    });
    expect(writes).toEqual(['b.zip']);
  });
});
