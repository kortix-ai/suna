/**
 * `stop_reason` is promoted out of the metadata blob onto the wire. What the
 * serializer must never do is widen the field: `metadata` is a free jsonb
 * column, so whatever is under `stopReason` is arbitrary until it is checked
 * against the catalogue.
 */
import { describe, expect, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

import { serializeSandboxRow } from './shared';

type Row = typeof sessionSandboxes.$inferSelect;

function rowWith(metadata: Record<string, unknown> | null): Row {
  return {
    sandboxId: 'sbx-1',
    sessionId: 'ses-1',
    projectId: 'prj-1',
    accountId: 'acc-1',
    provider: 'daytona',
    externalId: 'ext-1',
    baseUrl: null,
    status: 'stopped',
    config: {},
    metadata,
    lastUsedAt: null,
    createdAt: new Date('2026-08-14T18:24:51.624Z'),
    updatedAt: new Date('2026-08-14T18:24:51.624Z'),
  } as unknown as Row;
}

describe('serializeSandboxRow — stop_reason', () => {
  test('a catalogue member is promoted onto the wire', () => {
    expect(serializeSandboxRow(rowWith({ stopReason: 'runtime_boot_failed' })).stop_reason).toBe(
      'runtime_boot_failed',
    );
  });

  test('a live box has no stop to explain', () => {
    expect(serializeSandboxRow(rowWith({})).stop_reason).toBeNull();
  });

  test('a row parked before the field existed reads as null, not as an error', () => {
    expect(serializeSandboxRow(rowWith(null)).stop_reason).toBeNull();
  });

  test('a value outside the catalogue is dropped, never passed through', () => {
    // The wire type is a closed union. Forwarding an arbitrary string would
    // make the client's exhaustive copy map wrong at runtime while still
    // type-checking, which is the failure this check exists to prevent.
    for (const junk of ['something_else', '', 42, null, {}, ['manual']]) {
      expect(serializeSandboxRow(rowWith({ stopReason: junk })).stop_reason).toBeNull();
    }
  });

  test('the metadata blob still carries the raw value', () => {
    // Promotion is additive: nothing that read metadata.stopReason before is
    // broken by this.
    const serialized = serializeSandboxRow(rowWith({ stopReason: 'manual' }));
    expect((serialized.metadata as Record<string, unknown>).stopReason).toBe('manual');
  });
});
