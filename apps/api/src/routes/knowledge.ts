/**
 * Knowledge base routes — user-scoped searchable notes.
 *
 * Mounted at /v1/knowledge/* with combinedAuth.
 *
 * All routes enforce user_id scoping manually since the DB uses
 * the shared drizzle client (service-key level), not user-JWT RLS.
 *
 * Routes:
 *   GET    /v1/knowledge              — list notes (optional ?folder_path=)
 *   POST   /v1/knowledge              — create note
 *   GET    /v1/knowledge/search       — full-text search ?q=<query>
 *   GET    /v1/knowledge/:id          — get single note
 *   PUT    /v1/knowledge/:id          — update note
 *   DELETE /v1/knowledge/:id          — delete note
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { logger } from '../lib/logger';

// db.execute returns either an array-like RowList or an object with .rows
// depending on the postgres adapter version. Use this helper for safety.
function getRows<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] };
  if (Array.isArray(r.rows)) return r.rows;
  return [];
}

export const knowledgeApp = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUserId(c: any): string {
  return c.get('userId') as string;
}

interface NoteRow {
  id: string;
  user_id: string;
  folder_path: string;
  title: string;
  content_md: string;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow) {
  return {
    id: row.id,
    folder_path: row.folder_path,
    title: row.title,
    content_md: row.content_md,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── GET /v1/knowledge ────────────────────────────────────────────────────────

knowledgeApp.get('/', async (c) => {
  const userId = getUserId(c);
  const folderPath = c.req.query('folder_path');

  const rows = folderPath
    ? await db.execute(sql`
        SELECT id, user_id, folder_path, title, content_md, created_at, updated_at
        FROM kortix.knowledge_notes
        WHERE user_id = ${userId}::uuid AND folder_path = ${folderPath}
        ORDER BY updated_at DESC
      `)
    : await db.execute(sql`
        SELECT id, user_id, folder_path, title, content_md, created_at, updated_at
        FROM kortix.knowledge_notes
        WHERE user_id = ${userId}::uuid
        ORDER BY updated_at DESC
      `);

  return c.json({ notes: getRows<NoteRow>(rows).map(toNote) });
});

// ─── POST /v1/knowledge ───────────────────────────────────────────────────────

knowledgeApp.post('/', async (c) => {
  const userId = getUserId(c);
  const body = await c.req.json<{ folder_path?: string; title: string; content_md?: string }>();

  if (!body.title?.trim()) {
    return c.json({ error: 'title is required' }, 400);
  }

  const folderPath = body.folder_path?.trim() || '/';
  const title = body.title.trim();
  const contentMd = body.content_md ?? '';

  const result = await db.execute(sql`
    INSERT INTO kortix.knowledge_notes (user_id, folder_path, title, content_md)
    VALUES (${userId}::uuid, ${folderPath}, ${title}, ${contentMd})
    RETURNING id, user_id, folder_path, title, content_md, created_at, updated_at
  `);

  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Insert failed' }, 500);

  return c.json({ note: toNote(note) }, 201);
});

// ─── GET /v1/knowledge/search ────────────────────────────────────────────────

knowledgeApp.get('/search', async (c) => {
  const userId = getUserId(c);
  const q = c.req.query('q')?.trim();

  if (!q) return c.json({ results: [] });

  const rows = await db.execute(sql`
    SELECT id, user_id, folder_path, title, content_md, created_at, updated_at,
           ts_rank(search_vec, plainto_tsquery('english', ${q})) AS rank
    FROM kortix.knowledge_notes
    WHERE user_id = ${userId}::uuid
      AND search_vec @@ plainto_tsquery('english', ${q})
    ORDER BY rank DESC
    LIMIT 5
  `);

  const results = getRows<NoteRow>(rows).map((row) => ({
    id: row.id,
    title: row.title,
    folder_path: row.folder_path,
    snippet: (row.content_md ?? '').slice(0, 200),
  }));

  return c.json({ results });
});

// ─── GET /v1/knowledge/:id ────────────────────────────────────────────────────

knowledgeApp.get('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');

  const result = await db.execute(sql`
    SELECT id, user_id, folder_path, title, content_md, created_at, updated_at
    FROM kortix.knowledge_notes
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
  `);

  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Not found' }, 404);

  return c.json({ note: toNote(note) });
});

// ─── PUT /v1/knowledge/:id ────────────────────────────────────────────────────

knowledgeApp.put('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');
  const body = await c.req.json<{ folder_path?: string; title?: string; content_md?: string }>();

  // Verify ownership first
  const existing = await db.execute(sql`
    SELECT id FROM kortix.knowledge_notes WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
  `);
  if (!getRows<NoteRow>(existing)[0]) return c.json({ error: 'Not found' }, 404);

  const result = await db.execute(sql`
    UPDATE kortix.knowledge_notes
    SET
      folder_path = COALESCE(${body.folder_path ?? null}, folder_path),
      title       = COALESCE(${body.title ?? null}, title),
      content_md  = COALESCE(${body.content_md ?? null}, content_md),
      updated_at  = NOW()
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    RETURNING id, user_id, folder_path, title, content_md, created_at, updated_at
  `);

  const note = getRows<NoteRow>(result)[0];
  if (!note) return c.json({ error: 'Update failed' }, 500);

  return c.json({ note: toNote(note) });
});

// ─── DELETE /v1/knowledge/:id ─────────────────────────────────────────────────

knowledgeApp.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const id = c.req.param('id');

  const result = await db.execute(sql`
    DELETE FROM kortix.knowledge_notes
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    RETURNING id
  `);

  if (!getRows<NoteRow>(result)[0]) return c.json({ error: 'Not found' }, 404);

  return c.json({ ok: true });
});
