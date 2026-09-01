import { expect, test } from 'bun:test';

import { repairLegacyInlineAttachments } from './legacy-inline-attachment-repair';

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
