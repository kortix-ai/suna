/**
 * The secret-write rate limit for every `/secrets/*` route.
 *
 * This module is imported FIRST by every secrets route file (secrets.ts,
 * secret-personal.ts, secret-sync.ts) so the middleware registers before any
 * of their routes: it runs for every secret WRITE (including /broker and
 * /sync) and for nothing else. See the middleware's doc comment for the
 * 2026-08-21 storm it exists to stop. The pattern is concatenated because
 * unit-iam-gate-codemod-pin.test.ts strips block comments with a regex, and a
 * literal slash-star inside this string would read as a comment-opener and
 * swallow the next hundred lines of this file from its view.
 */
import { projectsApp } from '../lib/app';
import { createProjectSecretWriteRateLimitMiddleware } from '../../shared/rate-limit';

projectsApp.use('/:projectId/secrets/' + '*', createProjectSecretWriteRateLimitMiddleware());
