/**
 * Platform & Session Hooks for Kortix Computer Mobile
 *
 * These hooks provide:
 * 1. The user's current project-session sandbox
 * 2. Session reads from the OpenCode server
 * 3. Permission and question replies
 */

import { useQuery } from '@tanstack/react-query';
import { log } from '@/lib/logger';
import { getAuthToken } from '@/api/config';
import { getActiveSandbox, getSandboxUrl, listSandboxes } from './client';
import type { Session } from './types';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  sandbox: () => [...platformKeys.all, 'sandbox'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
  sessions: () => [...platformKeys.all, 'sessions'] as const,
  session: (id: string) => [...platformKeys.sessions(), id] as const,
  sessionMessages: (id: string) => [...platformKeys.session(id), 'messages'] as const,
};

// ─── Helper: Authenticated fetch to OpenCode server ──────────────────────────

async function opencodeFetch<T>(sandboxUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();

  const res = await fetch(`${sandboxUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenCode ${path} failed: ${res.status} - ${body}`);
  }

  return res.json();
}

// ─── Sandbox Hook ────────────────────────────────────────────────────────────

/**
 * The user's most relevant existing project-session sandbox (active →
 * provisioning → stopped → error), or `null` when there is none.
 *
 * Read-only: it never creates a session. Opening the app used to call
 * `ensureSandbox()` when no session existed, which provisioned a runtime
 * nobody asked for, and on a stack whose session create fails (e.g. a
 * loopback `KORTIX_URL`) it raised the same error on every app open.
 * Sessions start from the project composer.
 */
export function useSandbox(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.sandbox(),
    queryFn: async () => {
      // One listing: `getActiveSandbox` already returns the best row of every
      // project's sessions, in the priority order above.
      const sandbox = await getActiveSandbox();
      if (!sandbox) {
        log.log('📦 [useSandbox] No project-session sandbox yet');
        return null;
      }

      const sandboxUrl = getSandboxUrl(sandbox.external_id);
      log.log(`📦 [useSandbox] Using sandbox ${sandbox.external_id} (status=${sandbox.status})`);

      return {
        sandbox,
        sandboxUrl,
        sandboxId: sandbox.external_id,
      };
    },
    enabled,
    staleTime: 5 * 60 * 1000, // Sandbox doesn't change often
    retry: 2,
  });
}

// ─── Session List Hook ───────────────────────────────────────────────────────

/**
 * Lists all sessions from the OpenCode server.
 * GET {sandboxUrl}/session
 */
export function useSessions(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: platformKeys.sessions(),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('📋 [useSessions] Fetching sessions from:', sandboxUrl);
      const sessions = await opencodeFetch<Session[]>(sandboxUrl, '/session');

      // Sort by updated time descending (most recent first)
      const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
      log.log('✅ [useSessions] Got', sorted.length, 'sessions');
      return sorted;
    },
    enabled: !!sandboxUrl,
    staleTime: 10 * 1000, // Refresh every 10s
    refetchOnWindowFocus: true,
  });
}

// ─── Session Detail Hook ─────────────────────────────────────────────────────

/**
 * Get a single session by ID.
 * GET {sandboxUrl}/session/{id}
 */
export function useSession(sandboxUrl: string | undefined, sessionId: string | undefined) {
  return useQuery({
    queryKey: platformKeys.session(sessionId || ''),
    queryFn: async () => {
      if (!sandboxUrl || !sessionId) throw new Error('Missing sandboxUrl or sessionId');
      return opencodeFetch<Session>(sandboxUrl, `/session/${sessionId}`);
    },
    enabled: !!sandboxUrl && !!sessionId,
    staleTime: 5 * 1000,
  });
}

// ─── Permission Reply ───────────────────────────────────────────────────────

/**
 * Answer a pending permission request.
 * POST {sandboxUrl}/permission/{requestID}/reply — body `{ reply }`, the route
 * and body the opencode v2 client's `permission.reply` sends (the SDK's
 * `replyToPermission`).
 */
export async function replyToPermission(
  sandboxUrl: string,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
): Promise<void> {
  log.log('🔐 [replyToPermission] Replying to:', requestId, reply);
  await opencodeFetch<void>(sandboxUrl, `/permission/${requestId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ reply }),
  });
}

// ─── Question Reply / Reject ────────────────────────────────────────────────

/**
 * Reply to a pending question.
 * POST {sandboxUrl}/question/{requestID}/reply
 */
export async function replyToQuestion(
  sandboxUrl: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  log.log('💬 [replyToQuestion] Replying to:', requestId);
  await opencodeFetch<void>(sandboxUrl, `/question/${requestId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  });
}

/**
 * Reject (dismiss) a pending question.
 * POST {sandboxUrl}/question/{requestID}/reject
 */
export async function rejectQuestion(
  sandboxUrl: string,
  requestId: string,
): Promise<void> {
  log.log('❌ [rejectQuestion] Rejecting:', requestId);
  await opencodeFetch<void>(sandboxUrl, `/question/${requestId}/reject`, {
    method: 'POST',
  });
}

// ─── Instance Management Hooks ──────────────────────────────────────────────

export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: () => listSandboxes(),
    enabled,
    staleTime: 30 * 1000,
  });
}
