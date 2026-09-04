import { expect, test } from 'bun:test';

import {
  repairLegacyInlineAttachments,
  type LegacyRuntimeMessage,
} from './legacy-inline-attachment-repair';
import { materializePromptAttachments } from './prompt-attachment-materializer';
import type { PromptPartWire } from './store';

function repair(overrides: Partial<Parameters<typeof repairLegacyInlineAttachments>[0]> = {}) {
  return repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => null,
    readMessage: async () => null,
    materialize: async (parts) => parts,
    updatePart: async () => undefined,
    markRepaired: async () => undefined,
    ...overrides,
  });
}

test('does nothing when the pending-first row does not exist', async () => {
  let marked = false;
  expect(
    await repair({
      markRepaired: async () => {
        marked = true;
      },
    }),
  ).toEqual({ repaired: 0 });
  expect(marked).toBe(true);
});

test('does nothing when the pending-first row contains only native images', async () => {
  let marked = false;
  expect(
    await repair({
      loadPendingFirst: async () => ({
        commandId: 'command_first',
        deliveredMessageIds: ['msg_first'],
        parts: [
          {
            type: 'file',
            mime: 'image/png',
            filename: 'shot.png',
            url: 'data:image/png;base64,iVBORw0KGgo=',
          },
        ],
      }),
      markRepaired: async () => {
        marked = true;
      },
    }),
  ).toEqual({ repaired: 0 });
  expect(marked).toBe(true);
});

test('rejects when no delivered runtime message can be loaded', async () => {
  await expect(
    repair({
      loadPendingFirst: async () => ({
        commandId: 'command_first',
        deliveredMessageIds: ['msg_first'],
        parts: [
          {
            type: 'file',
            mime: 'application/zip',
            filename: 'bundle.zip',
            url: 'data:application/zip;base64,UEsDBA==',
          },
        ],
      }),
    }),
  ).rejects.toThrow('legacy attachment message was not found');
});

test('rejects ambiguous filename and MIME fallback matches', async () => {
  await expect(
    repair({
      loadPendingFirst: async () => ({
        commandId: 'command_first',
        deliveredMessageIds: ['msg_first'],
        parts: [
          { type: 'text', text: 'Inspect this.' },
          {
            type: 'file',
            mime: 'application/zip',
            filename: 'bundle.zip',
            url: 'data:application/zip;base64,UEsDBA==',
          },
        ],
      }),
      readMessage: async () => ({
        info: { id: 'msg_first', role: 'user' },
        parts: [
          { id: 'part_text', type: 'text', text: 'Inspect this.' },
          { id: 'part_gap', type: 'text', text: 'legacy shape changed' },
          {
            id: 'part_zip_1',
            type: 'file',
            mime: 'application/zip',
            filename: 'bundle.zip',
          },
          {
            id: 'part_zip_2',
            type: 'file',
            mime: 'APPLICATION/ZIP',
            filename: 'bundle.zip',
          },
        ],
      }),
      materialize: async () => [
        { type: 'text', text: 'Inspect this.' },
        { type: 'text', text: '<file filename="bundle.zip">bundle</file>' },
      ],
    }),
  ).rejects.toThrow('legacy attachment "bundle.zip" does not map to one runtime part');
});

test('repairs a legacy ZIP part in place and records completion', async () => {
  const updates: Array<{ messageId: string; partId: string; text: string }> = [];
  const result = await repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect this.' },
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [
        { id: 'part_text', type: 'text', text: 'Inspect this.' },
        {
          id: 'part_zip',
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    materialize: async () => [
      { type: 'text', text: 'Inspect this.' },
      {
        type: 'text',
        text: '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>',
      },
    ],
    updatePart: async ({ messageId, partId, text }) => {
      updates.push({ messageId, partId, text });
    },
    markRepaired: async () => undefined,
  });

  expect(result).toEqual({ repaired: 1 });
  expect(updates).toEqual([
    {
      messageId: 'msg_first',
      partId: 'part_zip',
      text: expect.stringContaining('filename="bundle.zip"'),
    },
  ]);
});

test('recognizes exact command-key XML without materializing or overwriting the file', async () => {
  const updates: Array<{ messageId: string; partId: string; text: string }> = [];
  let materializations = 0;
  let marks = 0;
  const canonicalXml =
    '<file path="/workspace/uploads/.kortix-inbox/command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>';

  const result = await repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect this.' },
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [
        { id: 'part_text', type: 'text', text: 'Inspect this.' },
        { id: 'part_zip', type: 'text', text: canonicalXml },
      ],
    }),
    materialize: async () => {
      materializations += 1;
      throw new Error('recognized transcript must not materialize');
    },
    updatePart: async (update) => {
      updates.push(update);
    },
    markRepaired: async () => {
      marks += 1;
    },
  });

  expect(result).toEqual({ repaired: 1 });
  expect(materializations).toBe(0);
  expect(updates).toEqual([]);
  expect(marks).toBe(1);
});

test('recognizes exact legacy repair XML without materializing again', async () => {
  let materializations = 0;
  let marks = 0;
  const legacyXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/0-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>';

  const result = await repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [{ id: 'part_zip', type: 'text', text: legacyXml }],
    }),
    materialize: async () => {
      materializations += 1;
      throw new Error('recognized transcript must not materialize');
    },
    updatePart: async () => {
      throw new Error('recognized transcript must not PATCH');
    },
    markRepaired: async () => {
      marks += 1;
    },
  });

  expect(result).toEqual({ repaired: 1 });
  expect(materializations).toBe(0);
  expect(marks).toBe(1);
});

test('a mixed batch materializes only original file parts at their original indices', async () => {
  const canonicalXml =
    '<file path="/workspace/uploads/.kortix-inbox/command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>';
  const markdownXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/2-README.md" mime="text/markdown" filename="README.md">\nThis file has been uploaded and is available at the path above.\n</file>';
  const materializedInputs: Array<{ key: string; parts: PromptPartWire[] }> = [];
  const writePaths: string[] = [];
  const updates: Array<{ messageId: string; partId: string; text: string }> = [];

  await repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect these.' },
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
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [
        { id: 'part_text', type: 'text', text: 'Inspect these.' },
        { id: 'part_zip', type: 'text', text: canonicalXml },
        {
          id: 'part_markdown',
          type: 'file',
          mime: 'text/markdown',
          filename: 'README.md',
        },
      ],
    }),
    materialize: async (parts, key) => {
      materializedInputs.push({ key, parts });
      return materializePromptAttachments({
        parts,
        externalId: 'sbx_1',
        sessionId: 'session_1',
        userId: 'user_1',
        materializationKey: key,
        writeFile: async (input) => {
          writePaths.push(input.targetPath);
          return { path: input.targetPath, size: input.bytes.byteLength };
        },
      });
    },
    updatePart: async (update) => {
      updates.push(update);
    },
    markRepaired: async () => undefined,
  });

  expect(materializedInputs).toHaveLength(1);
  expect(materializedInputs[0]!.key).toBe('legacy-command_first');
  expect(materializedInputs[0]!.parts[1]).toEqual({ type: 'text', text: canonicalXml });
  expect(materializedInputs[0]!.parts[2]).toMatchObject({
    type: 'file',
    filename: 'README.md',
  });
  expect(writePaths).toEqual([
    '/workspace/uploads/.kortix-inbox/legacy-command_first/2-README.md',
  ]);
  expect(updates).toEqual([
    { messageId: 'msg_first', partId: 'part_markdown', text: markdownXml },
  ]);
});

test('retries after the first of two part updates already succeeded', async () => {
  const zipXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>';
  const markdownXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/2-README.md" mime="text/markdown" filename="README.md">\nThis file has been uploaded and is available at the path above.\n</file>';
  const runtimeParts: LegacyRuntimeMessage['parts'] = [
    { id: 'part_text', type: 'text', text: 'Inspect these.' },
    {
      id: 'part_zip',
      type: 'file',
      mime: 'application/zip',
      filename: 'bundle.zip',
    },
    {
      id: 'part_markdown',
      type: 'file',
      mime: 'text/markdown',
      filename: 'README.md',
    },
  ];
  const updateAttempts: string[] = [];
  let failMarkdown = true;
  let marks = 0;
  const dependencies: Parameters<typeof repairLegacyInlineAttachments>[0] = {
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect these.' },
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
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: runtimeParts,
    }),
    materialize: async () => [
      { type: 'text', text: 'Inspect these.' },
      { type: 'text', text: zipXml },
      { type: 'text', text: markdownXml },
    ],
    updatePart: async ({ partId, text }) => {
      updateAttempts.push(partId);
      if (partId === 'part_markdown' && failMarkdown) {
        failMarkdown = false;
        throw new Error('second PATCH failed');
      }
      const part = runtimeParts.find(({ id }) => id === partId)!;
      part.type = 'text';
      part.text = text;
    },
    markRepaired: async () => {
      marks += 1;
    },
  };

  await expect(repairLegacyInlineAttachments(dependencies)).rejects.toThrow(
    'second PATCH failed',
  );
  expect(await repairLegacyInlineAttachments(dependencies)).toEqual({ repaired: 2 });
  expect(updateAttempts).toEqual(['part_zip', 'part_markdown', 'part_markdown']);
  expect(marks).toBe(1);
});

test('retries the marker after all part updates already succeeded', async () => {
  const zipXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/0-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>';
  const markdownXml =
    '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/1-README.md" mime="text/markdown" filename="README.md">\nThis file has been uploaded and is available at the path above.\n</file>';
  const runtimeParts: LegacyRuntimeMessage['parts'] = [
    {
      id: 'part_zip',
      type: 'file',
      mime: 'application/zip',
      filename: 'bundle.zip',
    },
    {
      id: 'part_markdown',
      type: 'file',
      mime: 'text/markdown',
      filename: 'README.md',
    },
  ];
  const updates: string[] = [];
  let markerAttempts = 0;
  const dependencies: Parameters<typeof repairLegacyInlineAttachments>[0] = {
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
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
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: runtimeParts,
    }),
    materialize: async () => [
      { type: 'text', text: zipXml },
      { type: 'text', text: markdownXml },
    ],
    updatePart: async ({ partId, text }) => {
      updates.push(partId);
      const part = runtimeParts.find(({ id }) => id === partId)!;
      part.type = 'text';
      part.text = text;
    },
    markRepaired: async () => {
      markerAttempts += 1;
      if (markerAttempts === 1) throw new Error('marker write failed');
    },
  };

  await expect(repairLegacyInlineAttachments(dependencies)).rejects.toThrow(
    'marker write failed',
  );
  expect(await repairLegacyInlineAttachments(dependencies)).toEqual({ repaired: 2 });
  expect(updates).toEqual(['part_zip', 'part_markdown']);
  expect(markerAttempts).toBe(2);
});
