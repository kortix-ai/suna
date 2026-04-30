/**
 * Knowledge base routes — user-scoped and team-scoped searchable notes.
 *
 * Mounted at /v1/knowledge/* with combinedAuth.
 *
 * Personal notes: user_id = authenticated user
 * Team notes:     scope = 'team', sandbox_id = active sandbox
 *                 write requires 'owner' role in sandbox_members
 *
 * GET    /v1/knowledge                  — list notes (?scope=team&sandbox_id=)
 * POST   /v1/knowledge                  — create note
 * GET    /v1/knowledge/search?q=        — full-text search
 * GET    /v1/knowledge/team-context     — all team notes for sandbox, formatted for injection
 * GET    /v1/knowledge/:id              — get single note
 * PUT    /v1/knowledge/:id              — update
 * DELETE /v1/knowledge/:id              — delete
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { logger } from '../lib/logger';

export const knowledgeApp = new Hono<AppEnv>();

// ─── Types ────────────────────────────────────────────────────────────────────

type KnowledgeScope = 'personal' | 'team';
type KnowledgeCategory = 'design_system' | 'component_library' | 'brand_guidelines' | null;

interface NoteRow {
  id: string;
  user_id: string;
  folder_path: string;
  title: string;
  content_md: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  sandbox_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(c: any): string { return c.get('userId') as string; }

function getRows<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] };
  if (Array.isArray(r.rows)) return r.rows;
  return [];
}

function toNote(row: NoteRow) {
  return {
    id: row.id,
    folder_path: row.folder_path,
    title: row.title,
    content_md: row.content_md,
    scope: row.scope,
    category: row.category,
    sandbox_id: row.sandbox_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Check if userId has owner role in the sandbox. */
async function isSandboxAdmin(userId: string, sandboxId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT account_role FROM kortix.sandbox_members
    WHERE sandbox_id = ${sandboxId}::uuid AND user_id = ${userId}::uuid
    LIMIT 1
  `);
  const rows = getRows<{ account_role: string }>(result);
  return rows[0]?.account_role === 'owner';
}

/** Derive the user's active sandbox ID (most recent). */
async function getActiveSandboxId(userId: string): Promise<string | null> {
  const accountId = await resolveAccountId(userId);
  const result = await db.execute(sql`
    SELECT sandbox_id FROM kortix.sandboxes
    WHERE account_id = ${accountId}::uuid
      AND status NOT IN ('archived', 'error')
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const rows = getRows<{ sandbox_id: string }>(result);
  return rows[0]?.sandbox_id ?? null;
}

// ─── GET /v1/knowledge ────────────────────────────────────────────────────────

knowledgeApp.get('/', async (c) => {
  const userId = uid(c);
  const folderPath = c.req.query('folder_path');
  const scope = (c.req.query('scope') ?? 'personal') as KnowledgeScope;
  const sandboxId = c.req.query('sandbox_id');

  let rows: NoteRow[];
  if (scope === 'team') {
    const sid = sandboxId ?? await getActiveSandboxId(userId);
    if (!sid) return c.json({ notes: [] });
    const result = await db.execute(sql`
      SELECT * FROM kortix.knowledge_notes
      WHERE scope = 'team' AND sandbox_id = ${sid}::uuid
        ${folderPath ? sql`AND folder_path = ${folderPath}` : sql``}
      ORDER BY updated_at DESC
    `);
    rows = getRows<NoteRow>(result);
  } else {
    const result = await db.execute(sql`
      SELECT * FROM kortix.knowledge_notes
      WHERE scope = 'personal' AND user_id = ${userId}::uuid
        ${folderPath ? sql`AND folder_path = ${folderPath}` : sql``}
      ORDER BY updated_at DESC
    `);
    rows = getRows<NoteRow>(result);
  }

  return c.json({ notes: rows.map(toNote) });
});

// ─── POST /v1/knowledge ───────────────────────────────────────────────────────

knowledgeApp.post('/', async (c) => {
  const userId = uid(c);
  const body = await c.req.json<{
    folder_path?: string;
    title: string;
    content_md?: string;
    scope?: KnowledgeScope;
    category?: KnowledgeCategory;
    sandbox_id?: string;
  }>();

  if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400);

  const scope: KnowledgeScope = body.scope === 'team' ? 'team' : 'personal';
  const category = body.category ?? null;
  const folderPath = body.folder_path?.trim() || '/';
  const title = body.title.trim();
  const contentMd = body.content_md ?? '';

  let sandboxId: string | null = null;
  if (scope === 'team') {
    sandboxId = body.sandbox_id ?? await getActiveSandboxId(userId);
    if (!sandboxId) return c.json({ error: 'No active sandbox for team note' }, 400);
    const isAdmin = await isSandboxAdmin(userId, sandboxId);
    if (!isAdmin) return c.json({ error: 'Only sandbox admins can create team notes' }, 403);
  }

  const result = await db.execute(sql`
    INSERT INTO kortix.knowledge_notes (user_id, folder_path, title, content_md, scope, category, sandbox_id)
    VALUES (
      ${userId}::uuid, ${folderPath}, ${title}, ${contentMd},
      ${scope}, ${category}, ${sandboxId ? sql`${sandboxId}::uuid` : sql`NULL`}
    )
    RETURNING *
  `);
  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Insert failed' }, 500);

  return c.json({ note: toNote(note) }, 201);
});

// ─── GET /v1/knowledge/search ────────────────────────────────────────────────

knowledgeApp.get('/search', async (c) => {
  const userId = uid(c);
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [] });

  // Search personal notes + team notes for user's sandboxes
  const result = await db.execute(sql`
    SELECT *, ts_rank(search_vec, plainto_tsquery('english', ${q})) AS rank
    FROM kortix.knowledge_notes
    WHERE (
      (scope = 'personal' AND user_id = ${userId}::uuid)
      OR (scope = 'team' AND sandbox_id IN (
        SELECT sandbox_id FROM kortix.sandbox_members WHERE user_id = ${userId}::uuid
      ))
    )
    AND search_vec @@ plainto_tsquery('english', ${q})
    ORDER BY rank DESC
    LIMIT 5
  `);

  const results = getRows<NoteRow & { rank: number }>(result).map((row) => ({
    id: row.id,
    title: row.title,
    folder_path: row.folder_path,
    scope: row.scope,
    category: row.category,
    snippet: (row.content_md ?? '').slice(0, 200),
  }));

  return c.json({ results });
});

// ─── GET /v1/knowledge/team-context ──────────────────────────────────────────

knowledgeApp.get('/team-context', async (c) => {
  const userId = uid(c);
  const sandboxId = c.req.query('sandbox_id') ?? await getActiveSandboxId(userId);

  if (!sandboxId) return c.json({ context_blocks: [], injected_text: '' });

  const result = await db.execute(sql`
    SELECT * FROM kortix.knowledge_notes
    WHERE scope = 'team' AND sandbox_id = ${sandboxId}::uuid
      AND category IS NOT NULL
    ORDER BY category, title
  `);
  const rows = getRows<NoteRow>(result);

  type ContextBlock = { category: string; title: string; content: string };
  const blocks: ContextBlock[] = rows.map((r) => ({
    category: r.category as string,
    title: r.title,
    content: r.content_md,
  }));

  // Build injected_text grouped by category
  const grouped: Record<string, ContextBlock[]> = {};
  for (const b of blocks) {
    if (!grouped[b.category]) grouped[b.category] = [];
    grouped[b.category]!.push(b);
  }

  const CATEGORY_LABELS: Record<string, string> = {
    design_system: 'Design System',
    component_library: 'Component Library',
    brand_guidelines: 'Brand Guidelines',
  };

  const sections: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const label = CATEGORY_LABELS[cat] ?? cat;
    const body = items.map((item) => `**${item.title}**\n${item.content}`).join('\n\n');
    sections.push(`=== ${label} ===\n${body}`);
  }

  const injectedText = sections.length > 0
    ? `[Team context]\n${sections.join('\n\n')}\n[/Team context]`
    : '';

  return c.json({ context_blocks: blocks, injected_text: injectedText });
});

// ─── GET /v1/knowledge/:id ────────────────────────────────────────────────────

knowledgeApp.get('/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');

  const result = await db.execute(sql`
    SELECT * FROM kortix.knowledge_notes
    WHERE id = ${id}::uuid
      AND (
        (scope = 'personal' AND user_id = ${userId}::uuid)
        OR (scope = 'team' AND sandbox_id IN (
          SELECT sandbox_id FROM kortix.sandbox_members WHERE user_id = ${userId}::uuid
        ))
      )
    LIMIT 1
  `);
  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Not found' }, 404);

  return c.json({ note: toNote(note) });
});

// ─── PUT /v1/knowledge/:id ────────────────────────────────────────────────────

knowledgeApp.put('/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const body = await c.req.json<{
    folder_path?: string; title?: string; content_md?: string; category?: KnowledgeCategory;
  }>();

  // Verify access and get note
  const existing = await db.execute(sql`
    SELECT * FROM kortix.knowledge_notes
    WHERE id = ${id}::uuid
      AND (
        (scope = 'personal' AND user_id = ${userId}::uuid)
        OR (scope = 'team' AND sandbox_id IN (
          SELECT sandbox_id FROM kortix.sandbox_members
          WHERE user_id = ${userId}::uuid AND account_role = 'owner'
        ))
      )
    LIMIT 1
  `);
  if (!getRows<NoteRow>(existing)[0]) return c.json({ error: 'Not found' }, 404);

  const result = await db.execute(sql`
    UPDATE kortix.knowledge_notes
    SET
      folder_path = COALESCE(${body.folder_path ?? null}, folder_path),
      title       = COALESCE(${body.title ?? null}, title),
      content_md  = COALESCE(${body.content_md ?? null}, content_md),
      category    = COALESCE(${body.category ?? null}, category),
      updated_at  = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `);
  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Update failed' }, 500);

  return c.json({ note: toNote(note) });
});

// ─── DELETE /v1/knowledge/:id ─────────────────────────────────────────────────

knowledgeApp.delete('/:id', async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');

  const result = await db.execute(sql`
    DELETE FROM kortix.knowledge_notes
    WHERE id = ${id}::uuid
      AND (
        (scope = 'personal' AND user_id = ${userId}::uuid)
        OR (scope = 'team' AND sandbox_id IN (
          SELECT sandbox_id FROM kortix.sandbox_members
          WHERE user_id = ${userId}::uuid AND account_role = 'owner'
        ))
      )
    RETURNING id
  `);
  if (!getRows<{ id: string }>(result)[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
