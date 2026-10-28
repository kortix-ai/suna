import { describe, expect, test } from 'bun:test';
import { legacyRehydrateSpec } from '../projects/legacy-migration-rehydrate';

describe('legacyRehydrateSpec', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

  test('reads source + pin from session metadata when the archive is the project id', () => {
    const spec = legacyRehydrateSpec(
      {
        legacy_migration: {
          source_sandbox_id: PROJECT,
          rehydrate: { opencode_session_id: 'ses_abc' },
        },
      },
      null,
      PROJECT,
    );
    expect(spec).toEqual({ sourceSandboxId: PROJECT, opencodeSessionId: 'ses_abc' });
  });

  test('accepts a session archive equal to the project archive (legacy sandbox migration)', () => {
    const spec = legacyRehydrateSpec(
      { legacy_migration: { source_sandbox_id: 'legacy-sbx-1' } },
      { legacy_migration: { source_sandbox_id: 'legacy-sbx-1' } },
      PROJECT,
    );
    expect(spec).toEqual({ sourceSandboxId: 'legacy-sbx-1', opencodeSessionId: null });
  });

  test('falls back to project metadata for the source id', () => {
    const spec = legacyRehydrateSpec({}, { legacy_migration: { source_sandbox_id: 'proj-2' } }, PROJECT);
    expect(spec).toEqual({ sourceSandboxId: 'proj-2', opencodeSessionId: null });
  });

  test('ignores a session archive that belongs to another project', () => {
    expect(
      legacyRehydrateSpec({ legacy_migration: { source_sandbox_id: OTHER_PROJECT } }, null, PROJECT),
    ).toBeNull();
    expect(
      legacyRehydrateSpec(
        { legacy_migration: { source_sandbox_id: OTHER_PROJECT } },
        { legacy_migration: { source_sandbox_id: PROJECT } },
        PROJECT,
      ),
    ).toEqual({ sourceSandboxId: PROJECT, opencodeSessionId: null });
  });

  test('returns null without legacy_migration metadata', () => {
    expect(legacyRehydrateSpec({}, {}, PROJECT)).toBeNull();
    expect(legacyRehydrateSpec(null, null, PROJECT)).toBeNull();
    expect(legacyRehydrateSpec({ legacy_migration: {} }, {}, PROJECT)).toBeNull();
  });
});
