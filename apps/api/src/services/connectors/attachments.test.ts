import { describe, expect, test } from 'bun:test';
import type { connectorAttachments } from '@kortix/db';
import {
  type ConnectorAttachmentScope,
  cleanupConnectorAttachmentCandidates,
  validateClaimRows,
} from './attachments';

const ID = '019fc40d-04dd-7f52-a591-65ab13d2a245';
const NOW = new Date('2026-08-02T20:00:00.000Z');

const scope: ConnectorAttachmentScope = {
  accountId: '019fc40d-04dd-7f52-a591-65ab13d2a111',
  projectId: '019fc40d-04dd-7f52-a591-65ab13d2a222',
  sessionId: '019fc40d-04dd-7f52-a591-65ab13d2a333',
  userId: '019fc40d-04dd-7f52-a591-65ab13d2a444',
};

type AttachmentRow = typeof connectorAttachments.$inferSelect;

function row(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    attachmentId: ID,
    accountId: scope.accountId,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    userId: scope.userId,
    objectPath: `connector-attachments/${scope.projectId}/${ID}`,
    filename: 'memo.pdf',
    contentType: 'application/pdf',
    contentDisposition: 'attachment',
    contentId: null,
    sizeBytes: 100,
    status: 'uploaded',
    claimToken: null,
    claimExpiresAt: null,
    expiresAt: new Date('2026-08-03T20:00:00.000Z'),
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('Connector attachment claim isolation', () => {
  test('accepts the exact account, project, session, and user scope', () => {
    expect(validateClaimRows([row()], [ID], scope, NOW)[0]?.attachmentId).toBe(ID);
  });

  test.each([
    ['account', { accountId: '019fc40d-04dd-7f52-a591-65ab13d2aff1' }],
    ['project', { projectId: '019fc40d-04dd-7f52-a591-65ab13d2aff2' }],
    ['session', { sessionId: '019fc40d-04dd-7f52-a591-65ab13d2aff3' }],
    ['user', { userId: '019fc40d-04dd-7f52-a591-65ab13d2aff4' }],
  ])('hides a handle from another %s scope', (_label, mismatch) => {
    expect(() => validateClaimRows([row(mismatch)], [ID], scope, NOW)).toThrow(
      'attachment_not_found',
    );
  });

  test('rejects expired and consumed handles', () => {
    expect(() =>
      validateClaimRows(
        [row({ expiresAt: new Date('2026-08-02T19:59:59.000Z') })],
        [ID],
        scope,
        NOW,
      ),
    ).toThrow('attachment_expired');
    expect(() => validateClaimRows([row({ status: 'consumed' })], [ID], scope, NOW)).toThrow(
      'attachment_already_consumed',
    );
  });

  test('rejects an active claim but permits recovery after its lease expires', () => {
    expect(() =>
      validateClaimRows(
        [row({ status: 'claimed', claimExpiresAt: new Date('2026-08-02T20:01:00.000Z') })],
        [ID],
        scope,
        NOW,
      ),
    ).toThrow('attachment_in_use');
    expect(
      validateClaimRows(
        [row({ status: 'claimed', claimExpiresAt: new Date('2026-08-02T19:59:00.000Z') })],
        [ID],
        scope,
        NOW,
      ),
    ).toHaveLength(1);
  });
});

describe('Connector attachment object cleanup', () => {
  const expired = {
    attachmentId: '019fc40d-04dd-7f52-a591-65ab13d2a246',
    objectPath: 'connector-attachments/project/expired',
  };
  const consumed = {
    attachmentId: '019fc40d-04dd-7f52-a591-65ab13d2a247',
    objectPath: 'connector-attachments/project/consumed',
  };

  test('deletes private objects before removing expired and consumed metadata', async () => {
    const events: string[] = [];
    const result = await cleanupConnectorAttachmentCandidates([expired, consumed], {
      removeObjects: async (paths) => {
        events.push(`objects:${paths.join(',')}`);
        return { deletedPaths: null, error: false };
      },
      deleteMetadata: async (ids) => {
        events.push(`metadata:${ids.join(',')}`);
      },
    });

    expect(result).toEqual({ deleted: 2, errors: 0 });
    expect(events).toEqual([
      `objects:${expired.objectPath},${consumed.objectPath}`,
      `metadata:${expired.attachmentId},${consumed.attachmentId}`,
    ]);
  });

  test('retains metadata when object deletion fails or is only partially confirmed', async () => {
    let deletedIds: string[] = [];
    expect(
      await cleanupConnectorAttachmentCandidates([expired, consumed], {
        removeObjects: async () => ({ deletedPaths: [], error: true }),
        deleteMetadata: async (ids) => {
          deletedIds = ids;
        },
      }),
    ).toEqual({ deleted: 0, errors: 2 });
    expect(deletedIds).toEqual([]);

    expect(
      await cleanupConnectorAttachmentCandidates([expired, consumed], {
        removeObjects: async () => ({ deletedPaths: [expired.objectPath], error: false }),
        deleteMetadata: async (ids) => {
          deletedIds = ids;
        },
      }),
    ).toEqual({ deleted: 1, errors: 1 });
    expect(deletedIds).toEqual([expired.attachmentId]);
  });
});
