import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRestoreScript,
  legacyRehydrateSpec,
  rekeyOpencodeDb,
} from '../projects/legacy-migration-rehydrate';

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

describe('rekeyOpencodeDb', () => {
  test('re-keys project and session rows to the live projectID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rekey-test-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      // The two tables rekeyOpencodeDb rewrites, as a migration archive carries them.
      const seed = new Database(dbPath);
      seed.exec('CREATE TABLE project (id TEXT PRIMARY KEY)');
      seed.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
      seed.exec("INSERT INTO project VALUES ('proj_original')");
      seed.exec("INSERT INTO session VALUES ('ses_one', 'proj_original'), ('ses_two', 'proj_original')");
      seed.close();

      const { sessions } = rekeyOpencodeDb(dbPath, 'live-project-id');
      expect(sessions).toBe(2);

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(
          (db.query('SELECT id FROM project').all() as Array<{ id: string }>).map((r) => r.id),
        ).toEqual(['live-project-id']);
        const rows = db.query('SELECT DISTINCT project_id FROM session').all() as Array<{
          project_id: string;
        }>;
        expect(rows).toEqual([{ project_id: 'live-project-id' }]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildRestoreScript', () => {
  test('kill pattern matches the real opencode.exe argv', () => {
    const script = buildRestoreScript();
    expect(script).toContain("pkill -9 -f 'opencode[^ ]* serve'");
    expect(/opencode[^ ]* serve/.test('/path/opencode.exe serve --port 4096')).toBe(true);
    expect('opencode serve'.includes('opencode.exe serve')).toBe(false);
  });

  test('resolves the store for both snapshot layouts', () => {
    const script = buildRestoreScript();
    expect(script).toContain('/home/kortix/.local/share/opencode');
    expect(script).toContain('/opt/kortix/home/.local/share/opencode');
  });
});
