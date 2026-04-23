import { Hono } from 'hono';
import { type Database } from '@kortix/db';

import { db as defaultDb } from '../../shared/db';
import { supabaseAuth as authMiddleware } from '../../middleware/auth';
import type { AuthVariables } from '../../types';

import {
  acceptInvite,
  declineInvite,
  describeInvite,
} from '../services/invites';
import { respondWithDomainError } from './http-errors';

export interface InvitesRouterDeps {
  db: Database;
  useAuth: boolean;
}

const defaults: InvitesRouterDeps = { db: defaultDb, useAuth: true };

export function createInvitesRouter(
  overrides: Partial<InvitesRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaults, ...overrides };
  const router = new Hono<{ Variables: AuthVariables }>();

  if (deps.useAuth) router.use('/*', authMiddleware);

  router.get('/:inviteId', async (c) => {
    try {
      const callerEmail = c.get('userEmail') as string | undefined;
      const invite = await describeInvite(deps.db, c.req.param('inviteId'), callerEmail);

      // When the caller isn't the invited address, we must not leak who the
      // invite was for, which account it belongs to, or who sent it — the URL
      // alone shouldn't reveal any of that to an unintended recipient.
      if (!invite.emailMatchesCaller) {
        return c.json({
          success: true,
          data: {
            invite_id: invite.inviteId,
            email_matches_caller: false,
            expired: invite.expired,
            accepted_at: invite.acceptedAt?.toISOString() ?? null,
            // Identifying fields are intentionally null.
            sandbox_id: null,
            sandbox_name: null,
            email: null,
            inviter_email: null,
            created_at: null,
            expires_at: null,
          },
        });
      }

      return c.json({
        success: true,
        data: {
          invite_id: invite.inviteId,
          sandbox_id: invite.sandboxId,
          sandbox_name: invite.sandboxName,
          email: invite.email,
          inviter_email: invite.inviterEmail,
          created_at: invite.createdAt.toISOString(),
          expires_at: invite.expiresAt.toISOString(),
          accepted_at: invite.acceptedAt?.toISOString() ?? null,
          email_matches_caller: true,
          expired: invite.expired,
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[INVITES] load error:');
    }
  });

  router.post('/:inviteId/accept', async (c) => {
    try {
      const userId = c.get('userId') as string;
      const userEmail = c.get('userEmail') as string | undefined;
      const result = await acceptInvite(deps.db, c.req.param('inviteId'), {
        userId,
        email: userEmail,
      });
      return c.json({
        success: true,
        data: {
          status: result.alreadyAccepted ? 'already_accepted' : 'accepted',
          sandbox_id: result.sandboxId,
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[INVITES] accept error:');
    }
  });

  router.post('/:inviteId/decline', async (c) => {
    try {
      const userEmail = c.get('userEmail') as string | undefined;
      await declineInvite(deps.db, c.req.param('inviteId'), userEmail);
      return c.json({ success: true, data: { status: 'declined' } });
    } catch (err) {
      return respondWithDomainError(c, err, '[INVITES] decline error:');
    }
  });

  return router;
}

export const invitesRouter = createInvitesRouter();
