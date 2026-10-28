// SPDX-License-Identifier: LicenseRef-Kortix-Enterprise
// Kortix Enterprise License (ee/LICENSE): production use needs a Kortix Enterprise subscription.

// The project audit log: GET /v1/projects/:projectId/audit, the `auditAccess`
// Enterprise feature for one project. Recording stays core and ungated.

import { redactHiddenChannelAuditRows } from '../../../shared/space-access';
import { auditCredentialNames } from '../../../shared/audit-credential-names';
import { createRoute, z } from '@hono/zod-openapi';
import { buildFilters } from '../../../accounts/audit-filters';
import { requireEntitlement } from '../../../accounts/iam/http-helpers';
import { PROJECT_ACTIONS } from '../../../iam';
import { auth, errors, json } from '../../../openapi';
import { AUDIT_READ_FLUSH_BARRIER_MS, flushAuditEvents } from '../../../shared/audit';
import {
  buildAuditCursorCondition,
  parseAuditCursor,
  parseAuditInstant,
  parseAuditLimit,
  readAuditEventPage,
  serializeAuditEvent,
} from '../../../shared/audit-query';
import { AuditActorTypeSchema, AuditListSchema } from '../../../shared/audit-schema';
import { db } from '../../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../../lib/access';
import { projectsApp } from '../../lib/app';
import { callerKortixSessionId } from '../../../middleware/caller-session';

/** Mounts the project audit log route on `projectsApp`. */
export function registerProjectAuditLogRoutes(): void {
  // GET /v1/projects/:projectId/audit
  // Canonical project slice. It returns the same event contract and cursor as
  // the account log, with project_id bound server-side to the authorized project.
  // This aggregate oversight surface can include private-session metadata, so it
  // requires the project-members management capability instead of session read.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/audit',
      tags: ['projects'],
      summary: 'List canonical project audit events',
      ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        query: z.object({
          action: z.string().optional(),
          actor: z.string().uuid().optional(),
          actor_type: AuditActorTypeSchema.optional(),
          session_id: z.string().optional(),
          source: z.string().optional(),
          credential_kind: z.string().optional(),
          phase: z.string().optional(),
          outcome: z.enum(['success', 'failure', 'denied', 'pending', 'expired']).optional(),
          request_id: z.string().optional(),
          correlation_id: z.string().optional(),
          resource_type: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          q: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.string().optional(),
        }),
      },
      responses: {
        200: json(AuditListSchema, 'Canonical project audit page'),
        ...errors(400, 402, 403, 404),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: AuditEventSchema declares `metadata` non-null but serializeAuditEvent returns null; the account audit route has the same boundary.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
      );
      const denied = await requireEntitlement(c, loaded.row.accountId, 'auditAccess');
      if (denied) return denied;

      const sinceRaw = c.req.query('since')?.trim() || null;
      const untilRaw = c.req.query('until')?.trim() || null;
      let cursor: ReturnType<typeof parseAuditCursor>;
      let limit: number;
      try {
        parseAuditInstant(sinceRaw, 'since');
        parseAuditInstant(untilRaw, 'until');
        cursor = parseAuditCursor(c.req.query('cursor')?.trim() || null);
        limit = parseAuditLimit(c.req.query('limit')?.trim() || null, 50, 200);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }

      const conditions = buildFilters(loaded.row.accountId, {
        actor: c.req.query('actor')?.trim() || null,
        actorType: c.req.query('actor_type')?.trim() || null,
        projectId,
        sessionId: c.req.query('session_id')?.trim() || null,
        source: c.req.query('source')?.trim() || null,
        credentialKind: c.req.query('credential_kind')?.trim() || null,
        phase: c.req.query('phase')?.trim() || null,
        outcome: c.req.query('outcome')?.trim() || null,
        requestId: c.req.query('request_id')?.trim() || null,
        correlationId: c.req.query('correlation_id')?.trim() || null,
        actionPrefix: c.req.query('action')?.trim() || null,
        resourceType: c.req.query('resource_type')?.trim() || null,
        sinceRaw,
        untilRaw,
        q: c.req.query('q')?.trim() || null,
      });
      if (cursor) {
        conditions.push(buildAuditCursorCondition(cursor, loaded.row.accountId, 'descending'));
      }
      // Audit writes are buffered off the request path (shared/audit-queue.ts).
      // A reader must observe every event already emitted, so drain the queue
      // before querying.
      await flushAuditEvents({ waitMs: AUDIT_READ_FLUSH_BARRIER_MS });
      const fetched = await readAuditEventPage(db, conditions, limit);
      const hasMore = fetched.length > limit;
      const page = hasMore ? fetched.slice(0, limit) : fetched;
      const last = page.at(-1);
      // A private channel's threads the manager is not in: metadata only.
      const rows = await redactHiddenChannelAuditRows(
        page,
        { userId: loaded.userId, bound: callerKortixSessionId(c) },
        { searching: Boolean(c.req.query('q')?.trim()) },
      );
      const names = await auditCredentialNames(rows);
      return c.json({
        events: rows.map((row) => serializeAuditEvent(row, names)),
        next_cursor: hasMore && last ? `${last.occurredAt.toISOString()}|${last.eventId}` : null,
      });
    },
  );
}
