/**
 * Agent session routes.
 *
 * Mounted at /v1/agents/*
 *
 * Routes:
 *   GET /v1/agents/sessions — list agent sessions with status, last-activity, etc.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { config } from '../config';
import { logger } from '../lib/logger';

export const agentsApp = new Hono<AppEnv>();

// ─── OpenCode URL resolution ──────────────────────────────────────────────────

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenCodeSession {
  id: string;
  title: string;
  time: { created: number; updated: number };
  [key: string]: unknown;
}

type AgentStatus = 'running' | 'idle' | 'blocked' | 'done' | 'error';

function mapStatus(statusType: string | undefined): AgentStatus {
  switch (statusType) {
    case 'busy':
    case 'retry':
      return 'running';
    case 'idle':
      return 'idle';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// ─── GET /v1/agents/sessions ─────────────────────────────────────────────────

agentsApp.get('/sessions', async (c) => {
  const baseUrl = getOpenCodeUrl();
  const headers = getOpenCodeHeaders();

  // Fetch session list and status in parallel
  const [sessionsRes, statusRes] = await Promise.allSettled([
    fetch(`${baseUrl}/session`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${baseUrl}/session/status`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  // Sessions list — required; return empty array if unreachable
  let sessions: OpenCodeSession[] = [];
  if (sessionsRes.status === 'fulfilled' && sessionsRes.value.ok) {
    try {
      sessions = await sessionsRes.value.json() as OpenCodeSession[];
    } catch {
      logger.warn('[Agents] Failed to parse /session response');
    }
  } else if (sessionsRes.status === 'rejected') {
    logger.warn('[Agents] /session unreachable', {
      error: sessionsRes.reason instanceof Error ? sessionsRes.reason.message : String(sessionsRes.reason),
    });
  }

  // Status map — optional; missing statuses default to 'idle'
  let statusMap: Record<string, { type: string }> = {};
  if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
    try {
      statusMap = await statusRes.value.json() as Record<string, { type: string }>;
    } catch {
      // non-fatal — status map stays empty
    }
  }

  const result = sessions.map((session) => {
    const statusType = statusMap[session.id]?.type;
    const lastActivityAt = new Date(session.time.updated).toISOString();

    return {
      session_id: session.id,
      task_title: (session.title ?? '').slice(0, 80),
      status: mapStatus(statusType),
      branch_name: null as string | null,  // requires per-session worktree query — not fetched here
      last_activity_at: lastActivityAt,
      pr_url: null as string | null,
      pr_ci_status: null as 'pending' | 'pass' | 'fail' | null,
    };
  });

  return c.json({ sessions: result });
});
