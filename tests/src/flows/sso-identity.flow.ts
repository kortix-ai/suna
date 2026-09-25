/**
 * SSO identity trust — which email a SAML IdP may vouch for (spec §5, SSO-*).
 *
 * Supabase marks every email a SAML IdP asserts as verified, and the IdP is
 * configured by an account admin. The API therefore trusts an IdP-asserted
 * email only for the domain its account proved it controls
 * (`account_sso_providers.domain_verified_at`). These flows pin that rule on
 * every surface that keys on an email:
 *
 *   SSO-1  domain verification itself, and `enforce_sso` (check-email plus the
 *          headless sign-in routes) applying only to a verified domain.
 *   SSO-2  invite list / describe / accept / decline, and add-member-by-email,
 *          for an SSO identity whose domain is not verified — then verified.
 *   SSO-3  SAML JIT identity merge: never on an unverified domain, never an
 *          owner, still for an ordinary member on a verified domain.
 *
 * SSO tokens come from `ssoFixtureToken`: a real Supabase user whose
 * server-controlled `app_metadata` names the IdP, exactly as the auth
 * middleware and `auth.users` see a SAML user.
 */
import { flow } from '../core/flow';
import type { Client } from '../core/client';
import type { FlowContext, Principal } from '../core/types';
import { asPlatformAdmin } from '../fixtures/enterprise-demo';
import { ssoFixtureToken } from '../fixtures/supabase';

async function saveProvider(
  ctx: FlowContext,
  accountId: string,
  body: { supabaseProviderId: string; domain: string; enforceSso?: boolean; autoCreateMembers?: boolean },
) {
  const r = await ctx.client.as(ctx.P.OWNER).put(
    '/v1/accounts/:accountId/iam/sso/provider',
    {
      supabase_sso_provider_id: body.supabaseProviderId,
      name: 'Synthetic IdP',
      primary_domain: body.domain,
      ...(body.enforceSso !== undefined ? { enforce_sso: body.enforceSso } : {}),
      ...(body.autoCreateMembers !== undefined ? { auto_create_members: body.autoCreateMembers } : {}),
    },
    { params: { accountId } },
  );
  r.status(200).body().has('$.provider.primary_domain', body.domain);
  return r.json<{ provider: Record<string, any> }>().provider;
}

async function operatorVerifies(ctx: FlowContext, accountId: string, verified: boolean) {
  return asPlatformAdmin(ctx).put(
    '/v1/admin/api/accounts/:id/sso-domain-verification',
    { verified },
    { params: { id: accountId } },
  );
}

async function checkEmailMode(ctx: FlowContext, email: string): Promise<string> {
  const r = await ctx.client.as(ctx.P.ANON).post('/v1/access/check-email', { email });
  r.status(200);
  return r.json<{ mode: string }>().mode;
}

flow(
  'SSO-1',
  {
    domain: 'iam',
    routes: [
      'PUT /v1/accounts/:accountId/iam/sso/provider',
      'GET /v1/accounts/:accountId/iam/sso/provider',
      'POST /v1/accounts/:accountId/iam/sso/provider/verify-domain',
      'PUT /v1/admin/api/accounts/:id/sso-domain-verification',
      'POST /v1/access/check-email',
      'POST /v1/auth/signup',
      'POST /v1/auth/sign-in/password',
      'POST /v1/auth/sign-in/magic-link',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const rival = await ctx.fixtures.team({ enterprise: true });
    const domain = `${ctx.fixtures.name('sso-verify')}.test`.toLowerCase();
    const email = `person@${domain}`;
    const password = 'Ke2e-sso-verify-2026!';
    const params = { accountId: team.id };
    let confirmationRequired = false;

    await ctx.step('a person on the domain signs up with a password before any SSO exists', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/auth/signup', { email, password });
      r.status(200).body().exists('$.user');
      confirmationRequired = r.json<{ requires_email_confirmation: boolean }>().requires_email_confirmation;
    });

    await ctx.step('the owner saves a provider that enforces SSO: the domain starts unverified with a TXT challenge', async () => {
      const provider = await saveProvider(ctx, team.id, {
        supabaseProviderId: crypto.randomUUID(),
        domain,
        enforceSso: true,
      });
      if (provider.domain_verified !== false || provider.domain_verified_at !== null) {
        throw new Error(`a new provider must start unverified: ${JSON.stringify(provider)}`);
      }
      const record = provider.domain_verification;
      if (
        record?.record_type !== 'TXT' ||
        record.record_name !== `_kortix-verification.${domain}` ||
        !String(record.record_value).startsWith('kortix-verification=')
      ) {
        throw new Error(`unexpected verification record: ${JSON.stringify(record)}`);
      }
    });

    await ctx.step('enforce_sso on an unverified domain changes nothing: check-email says signin, password sign-in works', async () => {
      const mode = await checkEmailMode(ctx, email);
      if (mode !== 'signin') throw new Error(`expected signin for an unverified domain, got ${mode}`);
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', { email, password });
      if (confirmationRequired) r.status(400);
      else r.status(200).body().exists('$.session.access_token');
    });

    await ctx.step('self-serve DNS verification without the TXT record → 422 naming the record to publish', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/:accountId/iam/sso/provider/verify-domain', {}, { params });
      r.status(422)
        .body()
        .has('$.code', 'sso_domain_unverified')
        .has('$.record_name', `_kortix-verification.${domain}`);
      const read = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/sso/provider', { params });
      read.status(200).body().has('$.provider.domain_verified', false);
    });

    await ctx.step('a plain member cannot verify the domain → 403', async () => {
      const member = await team.addMember('member');
      const r = await ctx.client
        .as(member)
        .post('/v1/accounts/:accountId/iam/sso/provider/verify-domain', {}, { params });
      r.status(403);
    });

    await ctx.step('an operator records the domain as verified → provider reads back verified', async () => {
      (await operatorVerifies(ctx, team.id, true)).status(200).body().has('$.domain_verified', true);
      const read = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/sso/provider', { params });
      read.status(200).body().has('$.provider.domain_verified', true).exists('$.provider.domain_verified_at');
    });

    await ctx.step('on the verified domain SSO is enforced: check-email says sso, password and email-code sign-in → 403', async () => {
      const mode = await checkEmailMode(ctx, email);
      if (mode !== 'sso') throw new Error(`expected sso for a verified enforced domain, got ${mode}`);
      (await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', { email, password }))
        .status(403)
        .body()
        .has('$.error', 'sso_required');
      (await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/magic-link', { email, create_user: false }))
        .status(403)
        .body()
        .has('$.error', 'sso_required');
    });

    await ctx.step('another account cannot verify a domain that is already verified → 409', async () => {
      await saveProvider(ctx, rival.id, { supabaseProviderId: crypto.randomUUID(), domain, enforceSso: false });
      (await operatorVerifies(ctx, rival.id, true)).status(409).body().has('$.code', 'sso_domain_claimed');
      (await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/:accountId/iam/sso/provider/verify-domain', {}, { params: { accountId: rival.id } }))
        .status(409)
        .body()
        .has('$.code', 'sso_domain_claimed');
      const mode = await checkEmailMode(ctx, email);
      if (mode !== 'sso') throw new Error(`the verified provider must keep the domain, got ${mode}`);
    });

    await ctx.step('changing the primary domain is a new claim: it starts unverified and the old domain is released', async () => {
      const other = `${ctx.fixtures.name('sso-moved')}.test`.toLowerCase();
      const moved = await saveProvider(ctx, team.id, { supabaseProviderId: crypto.randomUUID(), domain: other, enforceSso: true });
      if (moved.domain_verified !== false) throw new Error(`a changed domain must be unverified: ${JSON.stringify(moved)}`);
      const mode = await checkEmailMode(ctx, email);
      if (mode !== 'signin') throw new Error(`the released domain must fall back to signin, got ${mode}`);
    });

    await ctx.step('cleanup: remove both providers', async () => {
      for (const accountId of [team.id, rival.id]) {
        (await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/iam/sso/provider', { params: { accountId } })).status(200);
      }
    });
  },
);

flow(
  'SSO-2',
  {
    domain: 'iam',
    routes: [
      'PUT /v1/accounts/:accountId/iam/sso/provider',
      'PUT /v1/admin/api/accounts/:id/sso-domain-verification',
      'POST /v1/accounts/:accountId/members',
      'GET /v1/accounts/:accountId/members',
      'GET /v1/account-invites',
      'GET /v1/account-invites/:inviteId',
      'POST /v1/account-invites/:inviteId/accept',
      'POST /v1/account-invites/:inviteId/decline',
      'GET /v1/accounts/:accountId',
    ],
  },
  async (ctx) => {
    const idpTeam = await ctx.fixtures.team({ enterprise: true });
    const inviter = await ctx.fixtures.team();
    const supabaseProviderId = crypto.randomUUID();
    const inviteeDomain = `${ctx.fixtures.name('sso-invitee')}.test`.toLowerCase();
    const invitee = await ctx.fixtures.userWithEmail(`invitee@${inviteeDomain}`);
    let sso: Client;
    let inviteId = '';

    await ctx.step('an IdP account whose domain is unverified signs the invitee in over SSO', async () => {
      await saveProvider(ctx, idpTeam.id, {
        supabaseProviderId,
        domain: `${ctx.fixtures.name('sso-idp')}.test`.toLowerCase(),
      });
      sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, invitee, supabaseProviderId, []), 'SSO-invitee');
      (await sso.get('/v1/accounts')).status(200);
    });

    await ctx.step('another account adds the address: the unverified SSO identity does not match, so it is a pending invite', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/members',
        { email: invitee.email, role: 'admin' },
        { params: { accountId: inviter.id } },
      );
      r.status(201).body().has('$.status', 'pending').exists('$.invite_id');
      inviteId = r.json<{ invite_id: string }>().invite_id;
    });

    await ctx.step('the SSO identity cannot list, read, accept, or decline the invite', async () => {
      const list = await sso.get('/v1/account-invites');
      list.status(200);
      const ids = list.json<{ invites: Array<{ invite_id: string }> }>().invites.map((i) => i.invite_id);
      if (ids.includes(inviteId)) throw new Error('an unverified SSO email listed the invite');
      (await sso.get('/v1/account-invites/:inviteId', { params: { inviteId } }))
        .status(200)
        .body()
        .has('$.email_matches_caller', false)
        .has('$.account_id', null);
      (await sso.post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } }))
        .status(403)
        .body()
        .has('$.code', 'sso_email_domain_unverified');
      (await sso.post('/v1/account-invites/:inviteId/decline', {}, { params: { inviteId } }))
        .status(403)
        .body()
        .has('$.code', 'sso_email_domain_unverified');
      (await sso.get('/v1/accounts/:accountId', { params: { accountId: inviter.id } })).status(403);
      const members = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/members', { params: { accountId: inviter.id } });
      members.status(200);
      if (members.json<Array<{ user_id: string }>>().some((m) => m.user_id === invitee.userId)) {
        throw new Error('the unverified SSO identity became a member');
      }
    });

    await ctx.step('once the IdP account verifies the invitee domain, the same SSO identity lists and accepts the invite', async () => {
      await saveProvider(ctx, idpTeam.id, { supabaseProviderId, domain: inviteeDomain });
      (await operatorVerifies(ctx, idpTeam.id, true)).status(200).body().has('$.domain_verified', true);
      const list = await sso.get('/v1/account-invites');
      list.status(200);
      const ids = list.json<{ invites: Array<{ invite_id: string }> }>().invites.map((i) => i.invite_id);
      if (!ids.includes(inviteId)) throw new Error('a verified SSO email must list its invite');
      (await sso.post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } }))
        .status(200)
        .body()
        .has('$.account_id', inviter.id)
        .has('$.account_role', 'admin');
      (await sso.get('/v1/accounts/:accountId', { params: { accountId: inviter.id } })).status(200);
    });

    await ctx.step('cleanup: remove the provider', async () => {
      (await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/:accountId/iam/sso/provider', { params: { accountId: idpTeam.id } }))
        .status(200);
    });
  },
);

flow(
  'SSO-3',
  {
    domain: 'iam',
    routes: [
      'PUT /v1/accounts/:accountId/iam/sso/provider',
      'PUT /v1/admin/api/accounts/:id/sso-domain-verification',
      'POST /v1/accounts/:accountId/iam/scim/tokens',
      'POST /scim/v2/accounts/:accountId/Users',
      'PATCH /scim/v2/accounts/:accountId/Users/:userId',
      'PATCH /v1/accounts/:accountId/members/:userId',
      'GET /v1/accounts/:accountId/members',
      'GET /v1/accounts/:accountId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const params = { accountId: team.id };
    const supabaseProviderId = crypto.randomUUID();
    const domain = `${ctx.fixtures.name('sso-merge')}.test`.toLowerCase();
    const owner = ctx.client.as(ctx.P.OWNER);
    const tokenRes = await owner.post(
      '/v1/accounts/:accountId/iam/scim/tokens',
      { name: ctx.fixtures.name('scim') },
      { params },
    );
    tokenRes.status(201);
    const scim = ctx.client.withBearer(tokenRes.json<{ secret: string }>().secret, 'SCIM');

    const members = async () => {
      const r = await owner.get('/v1/accounts/:accountId/members', { params });
      r.status(200);
      return new Map(
        r.json<Array<{ user_id: string; account_role: string }>>().map((m) => [m.user_id, m.account_role]),
      );
    };

    /**
     * Point a directory row at an existing member, then give it the SSO
     * identity's email: the next SAML sign-in with that email finds the row and
     * proposes merging the existing member into the SSO identity.
     */
    const ssoSignInAgainst = async (existing: Principal, label: string): Promise<Principal> => {
      const created = await scim.post('/scim/v2/accounts/:accountId/Users', { userName: existing.email }, { params });
      created.status([200, 201]).body().has('$.id', existing.userId!);
      const person = await ctx.fixtures.userWithEmail(`${ctx.fixtures.name(label)}@${domain}`);
      (await scim.patch(
        '/scim/v2/accounts/:accountId/Users/:userId',
        { Operations: [{ op: 'replace', value: { userName: person.email } }] },
        { params: { ...params, userId: existing.userId! } },
      )).status(200);
      const sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, person, supabaseProviderId, []), `SSO-${label}`);
      (await sso.get('/v1/accounts/:accountId', { params })).status(200);
      return person;
    };

    await ctx.step('configure SSO for the account on a domain it has not verified', async () => {
      await saveProvider(ctx, team.id, { supabaseProviderId, domain, autoCreateMembers: true });
    });

    await ctx.step('unverified domain: the SSO sign-in joins as its own member and the existing member is kept', async () => {
      const existing = await team.addMember('member');
      const person = await ssoSignInAgainst(existing, 'unverified');
      const roles = await members();
      if (roles.get(existing.userId!) !== 'member') throw new Error('the existing member was merged away');
      if (roles.get(person.userId!) !== 'member') throw new Error('the SSO identity did not join as a member');
    });

    await ctx.step('an operator verifies the domain', async () => {
      (await operatorVerifies(ctx, team.id, true)).status(200).body().has('$.domain_verified', true);
    });

    await ctx.step('verified domain: an owner is never merged; the SSO identity joins as a plain member', async () => {
      const existing = await team.addMember('admin');
      (await owner.patch(
        '/v1/accounts/:accountId/members/:userId',
        { role: 'owner' },
        { params: { ...params, userId: existing.userId! } },
      )).status(200).body().has('$.account_role', 'owner');
      const person = await ssoSignInAgainst(existing, 'owner');
      const roles = await members();
      if (roles.get(existing.userId!) !== 'owner') throw new Error('the owner was merged into the SSO identity');
      if (roles.get(person.userId!) !== 'member') throw new Error(`the SSO identity must be a member, got ${roles.get(person.userId!)}`);
    });

    await ctx.step('verified domain: an ordinary member is still linked to the SSO identity', async () => {
      const existing = await team.addMember('member');
      const person = await ssoSignInAgainst(existing, 'linked');
      const roles = await members();
      if (roles.has(existing.userId!)) throw new Error('the member was not linked to the SSO identity');
      if (roles.get(person.userId!) !== 'member') throw new Error('the linked SSO identity lost the member role');
    });

    await ctx.step('cleanup: remove the provider', async () => {
      (await owner.del('/v1/accounts/:accountId/iam/sso/provider', { params })).status(200);
    });
  },
);

flow(
  'SSO-4',
  {
    domain: 'iam',
    routes: [
      'PUT /v1/accounts/:accountId/iam/sso/provider',
      'PUT /v1/admin/api/accounts/:id/sso-domain-verification',
      'POST /v1/accounts/:accountId/members',
      'GET /v1/accounts/:accountId/invites',
      'GET /v1/accounts',
      'POST /v1/accounts/:accountId/iam/scim/tokens',
      'POST /scim/v2/accounts/:accountId/Users',
    ],
  },
  async (ctx) => {
    const idpTeam = await ctx.fixtures.team({ enterprise: true });
    const inviter = await ctx.fixtures.team({ enterprise: true });
    const supabaseProviderId = crypto.randomUUID();
    const inviteeDomain = `${ctx.fixtures.name('sso-claim')}.test`.toLowerCase();
    const invitee = await ctx.fixtures.userWithEmail(`invitee@${inviteeDomain}`);
    // Invited BEFORE the account exists, so the invite stays pending until the
    // person's first account listing claims it.
    const passwordEmail = `${ctx.fixtures.name('pw-claim')}@example.test`.toLowerCase();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: inviter.id };
    let sso: Client;

    const accountIds = async (client: Client) => {
      const r = await client.get('/v1/accounts');
      r.status(200);
      return new Set(r.json<Array<{ account_id: string }>>().map((a) => a.account_id));
    };
    const pendingEmails = async () => {
      const r = await owner.get('/v1/accounts/:accountId/invites', { params });
      r.status(200);
      return new Set(r.json<Array<{ email: string }>>().map((i) => i.email.toLowerCase()));
    };

    await ctx.step('an IdP account with an unverified domain signs the invitee in over SSO', async () => {
      await saveProvider(ctx, idpTeam.id, { supabaseProviderId, domain: inviteeDomain });
      sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, invitee, supabaseProviderId, []), 'SSO-claim');
    });

    await ctx.step('another account invites the SSO address and a not-yet-registered address (plain account invites)', async () => {
      for (const email of [invitee.email!, passwordEmail]) {
        const r = await owner.post('/v1/accounts/:accountId/members', { email, role: 'member' }, { params });
        r.status(201).body().has('$.status', 'pending');
      }
    });

    await ctx.step('listing accounts does not auto-claim the invite for the unverified SSO identity', async () => {
      if ((await accountIds(sso)).has(inviter.id)) throw new Error('the unverified SSO identity was auto-joined');
      if (!(await pendingEmails()).has(invitee.email!.toLowerCase())) {
        throw new Error('the invite for the SSO address was consumed');
      }
    });

    await ctx.step('a SCIM directory entry for the address does not link the unverified SSO identity', async () => {
      const tokenRes = await owner.post('/v1/accounts/:accountId/iam/scim/tokens', { name: ctx.fixtures.name('scim') }, { params });
      tokenRes.status(201);
      const scim = ctx.client.withBearer(tokenRes.json<{ secret: string }>().secret, 'SCIM');
      const created = await scim.post('/scim/v2/accounts/:accountId/Users', { userName: invitee.email }, { params });
      created.status([200, 201]);
      if (created.json<{ id: string }>().id === invitee.userId) {
        throw new Error('SCIM linked the address to the unverified SSO identity');
      }
      if ((await accountIds(sso)).has(inviter.id)) throw new Error('the SCIM entry joined the unverified SSO identity');
    });

    await ctx.step('a password identity for the other address still auto-claims its plain invite on account listing', async () => {
      const password = ctx.client.as(await ctx.fixtures.userWithEmail(passwordEmail));
      if (!(await accountIds(password)).has(inviter.id)) throw new Error('the password identity was not auto-joined');
      if ((await pendingEmails()).has(passwordEmail)) throw new Error('the claimed invite is still pending');
    });

    await ctx.step('after the IdP account verifies the domain, the SSO identity auto-claims the remaining invite', async () => {
      (await operatorVerifies(ctx, idpTeam.id, true)).status(200).body().has('$.domain_verified', true);
      if (!(await accountIds(sso)).has(inviter.id)) throw new Error('a verified SSO identity must auto-claim its invite');
    });

    await ctx.step('cleanup: remove the provider', async () => {
      (await owner.del('/v1/accounts/:accountId/iam/sso/provider', { params: { accountId: idpTeam.id } })).status(200);
    });
  },
);
