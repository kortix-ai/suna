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
import {
  seedOpencodeSchema,
  writeConversations,
} from '../projects/suna-migration/opencode-db-writer';

describe('legacyRehydrateSpec', () => {
  test('reads source + pin from session metadata', () => {
    const spec = legacyRehydrateSpec(
      {
        legacy_migration: {
          source_sandbox_id: 'proj-1',
          rehydrate: { opencode_session_id: 'ses_abc' },
        },
      },
      null,
    );
    expect(spec).toEqual({ sourceSandboxId: 'proj-1', opencodeSessionId: 'ses_abc' });
  });

  test('falls back to project metadata for the source id', () => {
    const spec = legacyRehydrateSpec({}, { legacy_migration: { source_sandbox_id: 'proj-2' } });
    expect(spec).toEqual({ sourceSandboxId: 'proj-2', opencodeSessionId: null });
  });

  test('returns null without legacy_migration metadata', () => {
    expect(legacyRehydrateSpec({}, {})).toBeNull();
    expect(legacyRehydrateSpec(null, null)).toBeNull();
    expect(legacyRehydrateSpec({ legacy_migration: {} }, {})).toBeNull();
  });
});

describe('rekeyOpencodeDb', () => {
  test('re-keys project and session rows to the live projectID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rekey-test-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      seedOpencodeSchema(dbPath);
      writeConversations(dbPath, 'proj_original', [
        {
          title: 'One',
          messages: [
            {
              role: 'user',
              createdAt: new Date(0).toISOString(),
              parts: [{ type: 'text', text: 'hi' }],
            },
          ],
        },
        {
          title: 'Two',
          messages: [
            {
              role: 'user',
              createdAt: new Date(0).toISOString(),
              parts: [{ type: 'text', text: 'yo' }],
            },
          ],
        },
      ] as any);

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
