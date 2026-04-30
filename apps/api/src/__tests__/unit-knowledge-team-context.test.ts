import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../config', () => ({
  config: {
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'acc-test-123',
}));

// In-memory note store
const notes: Record<string, any> = {};
let noteCounter = 0;
const makeId = () => `note-${++noteCounter}`;

mock.module('../shared/db', () => ({
  db: {
    execute: async (sqlQuery: any) => {
      const sqlStr: string = sqlQuery?.queryChunks
        ?.map((c: any) => {
          if (typeof c === 'string') return c;
          if (c?.value) return Array.isArray(c.value) ? c.value.join('') : String(c.value);
          return '?';
        })
        .join('') ?? '';

      // team-context query — matches the /team-context route's SELECT on knowledge_notes
      if (sqlStr.includes('knowledge_notes') && sqlStr.includes('category IS NOT NULL')) {
        const matches = Object.values(notes).filter(
          (n: any) => n.scope === 'team' && n.category,
        );
        return { rows: matches };
      }
      // Generic knowledge_notes SELECT
      if (sqlStr.includes('knowledge_notes') && sqlStr.includes('SELECT')) {
        return { rows: [] };
      }

      // INSERT
      if (sqlStr.includes('INSERT INTO kortix.knowledge_notes')) {
        const [userId, folderPath, title, contentMd, scope, category, sandboxId] = sqlQuery.params ?? [];
        const id = makeId();
        const now = new Date().toISOString();
        const note = { id, user_id: userId, folder_path: folderPath ?? '/', title, content_md: contentMd ?? '',
          scope: scope ?? 'personal', category: category ?? null, sandbox_id: sandboxId ?? null,
          created_at: now, updated_at: now };
        notes[id] = note;
        return { rows: [note] };
      }

      // sandbox members admin check
      if (sqlStr.includes('sandbox_members') && sqlStr.includes('account_role')) {
        return { rows: [{ account_role: 'owner' }] };
      }

      // active sandbox
      if (sqlStr.includes('kortix.sandboxes') && sqlStr.includes('account_id')) {
        return { rows: [{ sandbox_id: 'sb-test-123' }] };
      }

      return { rows: [] };
    },
  },
  sql: (strings: any, ...values: any[]) => ({
    queryChunks: strings.raw ?? strings,
    params: values,
  }),
  eq: () => ({}),
  and: () => ({}),
}));

describe('GET /v1/knowledge/team-context', () => {
  const USER_ID = 'user-abc';

  beforeEach(() => {
    Object.keys(notes).forEach((k) => delete notes[k]);
    noteCounter = 0;
  });

  test('returns empty when no team notes', async () => {
    const cb = `?t=${Date.now()}`;
    const { knowledgeApp } = await import(`../routes/knowledge.ts${cb}`);

    const res = await knowledgeApp.request('http://localhost/team-context?sandbox_id=sb-test-123', { method: 'GET' });
    expect(res.status).toBe(200);
    const json = await res.json() as { context_blocks: any[]; injected_text: string };
    expect(json.context_blocks.length).toBe(0);
    expect(json.injected_text).toBe('');
  });

  test('two team notes appear in injected_text', async () => {
    // Directly seed the notes store so the mock returns them
    const id1 = makeId(); const id2 = makeId(); const now = new Date().toISOString();
    notes[id1] = { id: id1, user_id: USER_ID, folder_path: '/', title: 'Primary Colors',
      content_md: '#FF0000 red', scope: 'team', category: 'design_system',
      sandbox_id: 'sb-test-123', created_at: now, updated_at: now };
    notes[id2] = { id: id2, user_id: USER_ID, folder_path: '/', title: 'Button Component',
      content_md: 'Use <Button variant="primary">', scope: 'team', category: 'component_library',
      sandbox_id: 'sb-test-123', created_at: now, updated_at: now };

    const cb = `?t=${Date.now() + 1}`;
    const { knowledgeApp } = await import(`../routes/knowledge.ts${cb}`);

    const res = await knowledgeApp.request('http://localhost/team-context?sandbox_id=sb-test-123', { method: 'GET' });
    const json = await res.json() as { context_blocks: any[]; injected_text: string };

    expect(json.context_blocks.length).toBe(2);
    expect(json.injected_text).toContain('[Team context]');
    expect(json.injected_text).toContain('[/Team context]');
    expect(json.injected_text).toContain('Primary Colors');
    expect(json.injected_text).toContain('Button Component');
    expect(json.injected_text).toContain('Design System');
    expect(json.injected_text).toContain('Component Library');
  });
});
