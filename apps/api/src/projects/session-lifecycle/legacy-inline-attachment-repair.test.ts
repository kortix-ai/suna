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

test('a runtime that edits no parts (pi answers 501) skips the repair, marks it, and delivery goes on (R7.3)', async () => {
  let marks = 0;
  const patches: string[] = [];
  const result = await repair({
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'file', mime: 'application/zip', filename: 'bundle.zip', url: 'data:application/zip;base64,UEsDBA==' },
      ],
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [
        { id: 'part_text', type: 'text', text: 'Inspect this.' },
        { id: 'part_zip', type: 'file', mime: 'application/zip', filename: 'bundle.zip', url: '/kortix/part/oc_1/msg_first/part_zip' },
      ],
    }),
    materialize: async () => [
      { type: 'text', text: 'Inspect this.' },
      {
        type: 'text',
        text: '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>',
      },
    ],
    updatePart: async ({ partId }) => {
      patches.push(partId);
      return 'unsupported';
    },
    markRepaired: async () => {
      marks += 1;
    },
  });
  expect(result).toEqual({ repaired: 0, unsupported: true });
  expect(patches).toEqual(['part_zip']);
  expect(marks).toBe(1);
});
