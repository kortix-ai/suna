import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';

const POLL_INTERVAL_MS = 1500;
const RUNNING_STATUS = 'running';
const TERMINAL_STATUSES = new Set([RUNNING_STATUS, 'stopped', 'failed', 'completed']);
const MAX_POLLS = 80;

export interface SessionReadyResult {
  status: 'ready' | 'failed' | 'timeout' | 'gone';
  sandboxUrl: string | null;
  error: string | null;
}

export async function waitForSessionReady(sessionId: string): Promise<SessionReadyResult> {
  let polls = 0;
  while (polls < MAX_POLLS) {
    polls += 1;
    const [row] = await db
      .select({
        status: projectSessions.status,
        sandboxUrl: projectSessions.sandboxUrl,
        error: projectSessions.error,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!row) return { status: 'gone', sandboxUrl: null, error: null };
    if (row.status === RUNNING_STATUS) {
      return { status: 'ready', sandboxUrl: row.sandboxUrl, error: null };
    }
    if (row.status === 'failed' || row.status === 'stopped') {
      return { status: 'failed', sandboxUrl: row.sandboxUrl, error: row.error };
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { status: 'failed', sandboxUrl: row.sandboxUrl, error: row.error };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: 'timeout', sandboxUrl: null, error: null };
}

export function sessionLink(sessionId: string): string {
  const root = config.KORTIX_DASHBOARD_URL?.replace(/\/$/, '') || 'http://localhost:3000';
  return `${root}/sessions/${sessionId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
