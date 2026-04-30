/**
 * Parallel agent dispatch routes.
 *
 * Mounted at /v1/agents/parallel/* (combinedAuth)
 *
 * POST /v1/agents/parallel  — fan-out N agent sessions in parallel from a task list
 *
 * Design: each task gets its own OpenCode session, all created concurrently
 * via Promise.allSettled. Returns session IDs immediately — sessions run
 * async in the sandbox. Frontend polls via GET /v1/agents/sessions.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { config } from '../config';
import { logger } from '../lib/logger';

export const parallelApp = new Hono<AppEnv>();

// ─── OpenCode URL ─────────────────────────────────────────────────────────────

function getOpenCodeUrl(): string {
  const explicit = config.OPENCODE_URL ?? config.KORTIX_MASTER_URL;
  if (explicit?.trim()) return explicit.trim().replace(/\/+$/, '');
  return `http://localhost:${config.SANDBOX_PORT_BASE ?? 14000}`;
}

function getOpenCodeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (serviceKey) headers['Authorization'] = `Bearer ${serviceKey}`;
  return headers;
}

// ─── POST /v1/agents/parallel ─────────────────────────────────────────────────

parallelApp.post('/', async (c) => {
  let body: { tasks?: string[]; context?: string; agent?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { tasks, context, agent } = body;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return c.json({ error: 'tasks must be a non-empty array of strings' }, 400);
  }

  const validTasks = tasks.filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (validTasks.length === 0) {
    return c.json({ error: 'No valid tasks provided' }, 400);
  }

  if (validTasks.length > 20) {
    return c.json({ error: 'Maximum 20 parallel tasks per request' }, 400);
  }

  const baseUrl = getOpenCodeUrl();
  const headers = getOpenCodeHeaders();

  // Prepend shared context to each task if provided
  const buildPrompt = (task: string) => {
    if (!context?.trim()) return task.trim();
    return `${context.trim()}\n\n---\nTask: ${task.trim()}`;
  };

  // Create all sessions concurrently
  const results = await Promise.allSettled(
    validTasks.map(async (task, idx) => {
      const prompt = buildPrompt(task);
      const title = task.trim().slice(0, 60);

      // Create session
      const createRes = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!createRes.ok) {
        const err = await createRes.text().catch(() => '');
        throw new Error(`Session ${idx} create failed (${createRes.status}): ${err}`);
      }

      const session = await createRes.json() as { id: string };
      const sessionId = session.id;

      // Send initial task prompt
      const promptRes = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          ...(agent ? { agent } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!promptRes.ok) {
        logger.warn(`[parallel] Task ${idx} prompt failed`, { sessionId, status: promptRes.status });
      }

      return { session_id: sessionId, task: task.trim(), index: idx };
    }),
  );

  const succeeded = results
    .filter((r): r is PromiseFulfilledResult<{ session_id: string; task: string; index: number }> => r.status === 'fulfilled')
    .map((r) => r.value);

  const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r, i) => ({
      index: i,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    }));

  logger.info(`[parallel] Spawned ${succeeded.length}/${validTasks.length} sessions`, {
    succeeded: succeeded.length,
    failed: failed.length,
  });

  return c.json({
    sessions: succeeded,
    failed,
    total: validTasks.length,
    spawned: succeeded.length,
  }, 201);
});
