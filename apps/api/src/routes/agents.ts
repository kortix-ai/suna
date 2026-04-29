/**
 * Agent session routes.
 *
 * Mounted at /v1/agents/* (combinedAuth)
 *
 * GET  /v1/agents/sessions           — list agent sessions with live fields
 * POST /v1/agents/sessions           — launch a new agent session (optionally into a worktree)
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { config } from '../config';
import { logger } from '../lib/logger';

export const agentsApp = new Hono<AppEnv>();

// ─── OpenCode/kortix-master URL ──────────────────────────────────────────────

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

// ─── In-memory branch/PR metadata per session ───────────────────────────────

interface SessionMeta {
  branch_name: string | null;
  pr_url: string | null;
  diff_additions: number | null;
  diff_deletions: number | null;
}

const sessionMetaStore = new Map<string, SessionMeta>();

export function setSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
  const existing = sessionMetaStore.get(sessionId) ?? {
    branch_name: null,
    pr_url: null,
    diff_additions: null,
    diff_deletions: null,
  };
  sessionMetaStore.set(sessionId, { ...existing, ...meta });
}

export function getSessionMeta(sessionId: string): SessionMeta {
  return sessionMetaStore.get(sessionId) ?? {
    branch_name: null,
    pr_url: null,
    diff_additions: null,
    diff_deletions: null,
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface OpenCodeSession {
  id: string;
  title: string;
  time: { created: number; updated: number };
  [key: string]: unknown;
}

type AgentStatus = 'running' | 'idle' | 'blocked';

function mapStatus(statusType: string | undefined): AgentStatus {
  if (statusType === 'busy' || statusType === 'retry') return 'running';
  return 'idle';
}

// ─── GET /v1/agents/sessions ─────────────────────────────────────────────────

agentsApp.get('/sessions', async (c) => {
  const baseUrl = getOpenCodeUrl();
  const headers = getOpenCodeHeaders();

  const rawLimit = c.req.query('limit');
  const cursor = c.req.query('cursor') ?? null;
  const limit = Math.min(Math.max(1, parseInt(rawLimit ?? '20', 10) || 20), 100);

  // Fetch session list and status in parallel
  const [sessionsRes, statusRes] = await Promise.allSettled([
    fetch(`${baseUrl}/session`, { headers, signal: AbortSignal.timeout(8000) }),
    fetch(`${baseUrl}/session/status`, { headers, signal: AbortSignal.timeout(8000) }),
  ]);

  let sessions: OpenCodeSession[] = [];
  if (sessionsRes.status === 'fulfilled' && sessionsRes.value.ok) {
    try { sessions = await sessionsRes.value.json() as OpenCodeSession[]; } catch { /* ignore */ }
  } else if (sessionsRes.status === 'rejected') {
    logger.warn('[Agents] /session unreachable', {
      error: sessionsRes.reason instanceof Error ? sessionsRes.reason.message : String(sessionsRes.reason),
    });
  }

  let statusMap: Record<string, { type: string }> = {};
  if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
    try { statusMap = await statusRes.value.json() as Record<string, { type: string }>; } catch { /* ignore */ }
  }

  // Sort by last-activity descending, then paginate
  sessions.sort((a, b) => b.time.updated - a.time.updated);

  let startIdx = 0;
  if (cursor) {
    const idx = sessions.findIndex((s) => s.id === cursor);
    if (idx >= 0) startIdx = idx + 1;
  }

  // Fetch one extra to detect if there's a next page
  const page = sessions.slice(startIdx, startIdx + limit + 1);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  const result = page.map((session) => {
    const meta = getSessionMeta(session.id);
    const statusType = statusMap[session.id]?.type;

    return {
      session_id: session.id,
      task_title: (session.title ?? '').slice(0, 80),
      status: mapStatus(statusType) as AgentStatus,
      branch_name: meta.branch_name,
      last_activity_at: new Date(session.time.updated).toISOString(),
      diff_additions: meta.diff_additions,
      diff_deletions: meta.diff_deletions,
      pr_url: meta.pr_url,
    };
  });

  return c.json({ sessions: result, next_cursor: nextCursor });
});

// ─── POST /v1/agents/sessions ────────────────────────────────────────────────

agentsApp.post('/sessions', async (c) => {
  let body: { task?: string; worktree?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { task, worktree } = body;

  if (!task || typeof task !== 'string' || !task.trim()) {
    return c.json({ error: 'Missing required field: task' }, 400);
  }

  const baseUrl = getOpenCodeUrl();
  const headers = getOpenCodeHeaders();

  let sessionDirectory: string | undefined;

  // ── Optionally create git worktree ──────────────────────────────────────────
  if (worktree && typeof worktree === 'string' && worktree.trim()) {
    const branch = worktree.trim();
    const workspaceRoot = '/workspace';
    const worktreePath = `/workspace/.worktrees/${branch.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    const execRes = await fetch(`${baseUrl}/kortix/core/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cmd: `git -C ${JSON.stringify(workspaceRoot)} worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)} 2>&1 || git -C ${JSON.stringify(workspaceRoot)} worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)} 2>&1`,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (execRes.ok) {
      const execResult = await execRes.json() as { code: number; stdout: string; stderr: string };
      if (execResult.code !== 0) {
        logger.warn('[Agents] git worktree add failed', { branch, output: execResult.stdout + execResult.stderr });
        return c.json(
          { error: `Failed to create worktree for branch "${branch}": ${(execResult.stdout + execResult.stderr).slice(0, 200)}` },
          422,
        );
      }
      sessionDirectory = worktreePath;
      logger.info(`[Agents] Created worktree at ${worktreePath} for branch ${branch}`);
    } else {
      const errText = await execRes.text().catch(() => '');
      logger.warn('[Agents] /exec endpoint failed', { status: execRes.status, error: errText });
      return c.json({ error: 'Worktree creation failed: exec endpoint unreachable' }, 503);
    }
  }

  // ── Create OpenCode session ─────────────────────────────────────────────────
  const dirQuery = sessionDirectory ? `?directory=${encodeURIComponent(sessionDirectory)}` : '';
  const createRes = await fetch(`${baseUrl}/session${dirQuery}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: task.trim().slice(0, 80) }),
    signal: AbortSignal.timeout(15000),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    logger.error('[Agents] Session create failed', { status: createRes.status, error: errText });
    return c.json({ error: 'Failed to create agent session' }, 502);
  }

  const session = await createRes.json() as { id: string };
  const sessionId = session.id;

  // ── Store branch metadata ───────────────────────────────────────────────────
  if (worktree) {
    setSessionMeta(sessionId, { branch_name: worktree.trim() });
  }

  // ── Send initial task prompt async ─────────────────────────────────────────
  const promptRes = await fetch(`${baseUrl}/session/${sessionId}/prompt_async${dirQuery}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ parts: [{ type: 'text', text: task.trim() }] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!promptRes.ok) {
    logger.warn('[Agents] Initial prompt failed', { sessionId, status: promptRes.status });
  }

  logger.info(`[Agents] Session ${sessionId} started (task: "${task.trim().slice(0, 60)}...", branch: ${worktree ?? 'default'})`);

  return c.json({
    session_id: sessionId,
    branch_name: worktree?.trim() ?? null,
    status: 'running' as AgentStatus,
  }, 201);
});
