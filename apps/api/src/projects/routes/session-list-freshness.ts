/**
 * Keeps the session list fresh after a write to a project's sessions.
 *
 * The list's poll memo (`lib/session-list-poll-memo.ts`) answers a repeat of
 * the same list query, inside its 2 s window, with a 304 for the ETag it
 * computed before. A client refetches the list right after its own write
 * (create, rename, labels, pin, archive, delete, restore, sharing, filing into
 * a group), and the browser sends the ETag it holds: the memo answered 304 and
 * the client kept the body from before the write, so the change vanished from
 * the list until the next poll. This middleware forgets the project's
 * memoized pages once such a write succeeds. Reads pass through untouched.
 *
 * registerAllProjectRoutes() (projects/index.ts) calls it right after the auth
 * middleware, before any session route, so it wraps every one of them. The
 * patterns are concatenated: a literal slash-star in a string reads as a
 * comment opener to unit-iam-gate-codemod-pin.test.ts.
 */
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../../types';
import { projectsApp } from '../lib/app';
import { forgetSessionListPollEtags } from '../lib/session-list-poll-memo';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const forgetAfterWrite = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (READS.has(c.req.method) || c.res.status >= 400) return;
  const projectId = c.req.param('projectId');
  if (projectId) forgetSessionListPollEtags(projectId);
});

export function registerSessionListFreshnessMiddleware(): void {
  projectsApp.use('/:projectId/sessions', forgetAfterWrite);
  projectsApp.use('/:projectId/sessions/' + '*', forgetAfterWrite);
}
