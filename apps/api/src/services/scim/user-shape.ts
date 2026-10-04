// SCIM 2.0 User resource shapes shared by the SCIM routes and the directory service.

export function locationFor(accountId: string, kind: 'Users' | 'Groups', id: string): string {
  return `/scim/v2/accounts/${accountId}/${kind}/${id}`;
}

export interface UserShape {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails: Array<{ value: string; primary: boolean }>;
  externalId?: string | null;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

/**
 * Serialize a PENDING INVITATION as a SCIM User. An invited-but-not-yet-joined
 * person is a valid, ENABLED account from the IdP's point of view — so we return
 * `active: true` (NOT false). Returning false made Okta treat the just-pushed
 * user as deactivated and loop forever "reactivating" it. The SCIM id is the
 * invitation id; once the person signs in via SSO they become a real member and
 * are served by `buildUser` instead (the IdP re-correlates by userName/email).
 */
export function buildInviteUser(
  accountId: string,
  invite: { inviteId: string; email: string; createdAt: Date; externalId?: string | null },
  active = true,
): UserShape {
  const iso = invite.createdAt.toISOString();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: invite.inviteId,
    userName: invite.email,
    active,
    emails: [{ value: invite.email, primary: true }],
    externalId: invite.externalId ?? null,
    meta: {
      resourceType: 'User',
      created: iso,
      lastModified: iso,
      location: locationFor(accountId, 'Users', invite.inviteId),
    },
  };
}
