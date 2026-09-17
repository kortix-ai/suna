/**
 * SCIM 2.0 provisioning surface — mounted at /scim/v2/accounts/:accountId/*
 * (apps/api/src/index.ts → app.route('/scim/v2', scimRouter)). Maps to spec
 * §scim (SCIM-*).
 *
 * Auth model (apps/api/src/middleware/scim-auth.ts):
 *   - EVERY /scim/v2/accounts/:accountId/* route (incl. ServiceProviderConfig)
 *     is behind `scimAuth`, which requires a per-account SCIM *bearer token*
 *     minted via POST /v1/accounts/:accountId/iam/scim/tokens. The user JWT is
 *     NOT a SCIM token, so OWNER's JWT → 401. Missing/empty bearer → 401.
 *   - A SCIM token whose account != the :accountId in the URL → 403.
 *
 * SCIM errors use the RFC 7644 envelope: { schemas:[...], status, detail }.
 * Resources/lists use the SCIM schemas (ListResponse, core User/Group).
 *
 * We mint a real SCIM token for the OWNER-owned team account to exercise the
 * 200/201 happy paths, then drive Users + Groups CRUD over that bearer.
 */
import { flow } from '../core/flow';
import type { Client } from '../core/client';
import type { FlowContext } from '../core/types';
import { ssoFixtureToken } from '../fixtures/supabase';

/** Mint a per-account SCIM bearer token for an account the OWNER controls. */
async function mintScimToken(ctx: FlowContext, accountId: string): Promise<string> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .post(
      '/v1/accounts/:accountId/iam/scim/tokens',
      { name: ctx.fixtures.name('scim') },
      { params: { accountId } },
    );
  r.status(201).body().exists('$.secret');
  return r.json<any>().secret as string;
}

flow(
  'SCIM-1',
  {
    domain: 'scim',
    tags: ['smoke'],
    routes: [
      'GET /scim/v2/accounts/:accountId/ServiceProviderConfig',
      'GET /scim/v2/accounts/:accountId/ResourceTypes',
      'GET /scim/v2/accounts/:accountId/Schemas',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    let scim: Client;

    await ctx.step('OWNER mints a SCIM token for the team account', async () => {
      const token = await mintScimToken(ctx, team.id);
      scim = ctx.client.withBearer(token, 'SCIM');
    });

    await ctx.step('ServiceProviderConfig with SCIM token → 200 capabilities', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/ServiceProviderConfig', {
        params: { accountId: team.id },
      });
      r.status(200)
        .body()
        .exists('$.schemas')
        .exists('$.patch.supported')
        .exists('$.authenticationSchemes');
    });

    await ctx.step('ResourceTypes → 200 with User + Group (Azure AD probes this)', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/ResourceTypes', {
        params: { accountId: team.id },
      });
      r.status(200)
        .body()
        .has('$.totalResults', 2)
        .has('$.Resources[0].id', 'User')
        .has('$.Resources[1].id', 'Group');
    });

    await ctx.step('Schemas → 200 with the core User schema + its attributes', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Schemas', {
        params: { accountId: team.id },
      });
      r.status(200)
        .body()
        .has('$.Resources[0].id', 'urn:ietf:params:scim:schemas:core:2.0:User')
        .exists('$.Resources[0].attributes');
    });

    await ctx.step('OWNER JWT (not a SCIM token) → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/scim/v2/accounts/:accountId/ServiceProviderConfig', {
          params: { accountId: team.id },
        });
      r.status(401);
    });

    await ctx.step('no bearer at all → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/scim/v2/accounts/:accountId/ServiceProviderConfig', {
          params: { accountId: team.id },
        });
      r.status(401);
    });
  },
);

flow(
  'SCIM-2',
  {
    domain: 'scim',
    routes: [
      'GET /scim/v2/accounts/:accountId/Users',
      'POST /scim/v2/accounts/:accountId/Users',
      'GET /scim/v2/accounts/:accountId/Users/:userId',
      'PATCH /scim/v2/accounts/:accountId/Users/:userId',
      'DELETE /scim/v2/accounts/:accountId/Users/:userId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    let scim: Client;

    await ctx.step('mint SCIM token', async () => {
      scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
    });

    await ctx.step('list Users → SCIM ListResponse', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Users', {
        params: { accountId: team.id },
      });
      r.status(200).body().exists('$.schemas').exists('$.Resources').exists('$.totalResults');
    });

    await ctx.step('list Users with userName filter → ListResponse', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Users', {
        params: { accountId: team.id },
        query: { filter: 'userName eq "nobody@ke2e.kortix.test"' },
      });
      r.status(200).body().has('$.totalResults', 0);
    });

    await ctx.step('POST Users with no userName → 400', async () => {
      const r = await scim.post(
        '/scim/v2/accounts/:accountId/Users',
        {},
        { params: { accountId: team.id } },
      );
      r.status(400).body().exists('$.detail');
    });

    await ctx.step('POST Users for an unknown email → 201 invite, active:true', async () => {
      const userName = `${ctx.fixtures.name('scim-user')}@ke2e.kortix.test`;
      const r = await scim.post(
        '/scim/v2/accounts/:accountId/Users',
        { userName, externalId: 'ext-ke2e-1' },
        { params: { accountId: team.id } },
      );
      // active:true — an invited account is enabled; returning false made Okta
      // loop "reactivating" the user it had just pushed.
      r.status(201).body().has('$.active', true).has('$.userName', userName).exists('$.id');
    });

    await ctx.step('GET unknown user → 404 SCIM error', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Users/:userId', {
        params: { accountId: team.id, userId: '00000000-0000-4000-8000-000000000000' },
      });
      r.status(404).body().exists('$.detail');
    });

    await ctx.step('PATCH active:false on unknown user → idempotent 204', async () => {
      const r = await scim.patch(
        '/scim/v2/accounts/:accountId/Users/:userId',
        { Operations: [{ op: 'replace', path: 'active', value: false }] },
        { params: { accountId: team.id, userId: '00000000-0000-4000-8000-000000000000' } },
      );
      r.status(204);
    });

    await ctx.step('PATCH (reactivate/update) unknown user → 404', async () => {
      const r = await scim.patch(
        '/scim/v2/accounts/:accountId/Users/:userId',
        { Operations: [{ op: 'replace', path: 'externalId', value: 'x' }] },
        { params: { accountId: team.id, userId: '00000000-0000-4000-8000-000000000000' } },
      );
      r.status(404);
    });

    await ctx.step('DELETE unknown user → idempotent 204', async () => {
      const r = await scim.del('/scim/v2/accounts/:accountId/Users/:userId', {
        params: { accountId: team.id, userId: '00000000-0000-4000-8000-000000000000' },
      });
      r.status(204);
    });

    await ctx.step(
      'PUT is implemented (Okta profile push) — active:false → idempotent 204',
      async () => {
        // Regression guard: PUT used to be unrouted, so Okta's "Push Profile
        // Updates" (a PUT) got a bare 404 "Not Found". It now routes through the
        // shared write path.
        const r = await scim.put(
          '/scim/v2/accounts/:accountId/Users/:userId',
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'x@ke2e.kortix.test',
            active: false,
          },
          { params: { accountId: team.id, userId: '00000000-0000-4000-8000-000000000000' } },
        );
        r.status(204);
      },
    );

    await ctx.step('OWNER JWT on Users → 401 (SCIM token required)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/scim/v2/accounts/:accountId/Users', { params: { accountId: team.id } });
      r.status(401);
    });
  },
);

flow(
  'SCIM-3',
  {
    domain: 'scim',
    routes: [
      'GET /scim/v2/accounts/:accountId/Groups',
      'POST /scim/v2/accounts/:accountId/Groups',
      'GET /scim/v2/accounts/:accountId/Groups/:groupId',
      'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
      'PUT /scim/v2/accounts/:accountId/Groups/:groupId',
      'DELETE /scim/v2/accounts/:accountId/Groups/:groupId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    let scim: Client;
    let groupId = '';

    await ctx.step('mint SCIM token', async () => {
      scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
    });

    await ctx.step('list Groups → SCIM ListResponse', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Groups', {
        params: { accountId: team.id },
      });
      r.status(200).body().exists('$.Resources').exists('$.totalResults');
    });

    await ctx.step('POST Group with no displayName → 400', async () => {
      const r = await scim.post(
        '/scim/v2/accounts/:accountId/Groups',
        {},
        { params: { accountId: team.id } },
      );
      r.status(400).body().exists('$.detail');
    });

    await ctx.step('POST Group → 201 with id + displayName', async () => {
      const displayName = ctx.fixtures.name('scim-group');
      const r = await scim.post(
        '/scim/v2/accounts/:accountId/Groups',
        { displayName, externalId: 'grp-ke2e-1' },
        { params: { accountId: team.id } },
      );
      r.status(201).body().has('$.displayName', displayName).exists('$.id');
      groupId = r.json<any>().id;
    });

    await ctx.step('GET the created Group → 200', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
        params: { accountId: team.id, groupId },
      });
      r.status(200).body().has('$.id', groupId);
    });

    await ctx.step('PATCH replace displayName → 200', async () => {
      const next = ctx.fixtures.name('scim-group-renamed');
      const r = await scim.patch(
        '/scim/v2/accounts/:accountId/Groups/:groupId',
        { Operations: [{ op: 'replace', path: 'displayName', value: next }] },
        { params: { accountId: team.id, groupId } },
      );
      r.status(200).body().has('$.displayName', next);
    });

    await ctx.step('PUT full-resource rename (Okta group push) → 200', async () => {
      // Okta renames pushed groups via PUT with the FULL resource. No members
      // key here → membership must be left alone (only a present array is
      // authoritative).
      const next = ctx.fixtures.name('scim-group-put');
      const r = await scim.put(
        '/scim/v2/accounts/:accountId/Groups/:groupId',
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          id: groupId,
          displayName: next,
        },
        { params: { accountId: team.id, groupId } },
      );
      r.status(200).body().has('$.displayName', next).has('$.id', groupId);
    });

    await ctx.step('GET unknown Group → 404 SCIM error', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
        params: { accountId: team.id, groupId: '00000000-0000-4000-8000-000000000000' },
      });
      r.status(404).body().exists('$.detail');
    });

    await ctx.step('PUT unknown Group → 404', async () => {
      const r = await scim.put(
        '/scim/v2/accounts/:accountId/Groups/:groupId',
        { displayName: 'x' },
        { params: { accountId: team.id, groupId: '00000000-0000-4000-8000-000000000000' } },
      );
      r.status(404);
    });

    await ctx.step('PATCH unknown Group → 404', async () => {
      const r = await scim.patch(
        '/scim/v2/accounts/:accountId/Groups/:groupId',
        { Operations: [{ op: 'replace', path: 'displayName', value: 'x' }] },
        { params: { accountId: team.id, groupId: '00000000-0000-4000-8000-000000000000' } },
      );
      r.status(404);
    });

    await ctx.step('DELETE the Group → 204', async () => {
      const r = await scim.del('/scim/v2/accounts/:accountId/Groups/:groupId', {
        params: { accountId: team.id, groupId },
      });
      r.status(204);
    });

    await ctx.step('DELETE unknown Group → idempotent 204', async () => {
      const r = await scim.del('/scim/v2/accounts/:accountId/Groups/:groupId', {
        params: { accountId: team.id, groupId: '00000000-0000-4000-8000-000000000000' },
      });
      r.status(204);
    });
  },
);

flow(
  'SCIM-4',
  {
    domain: 'scim',
    routes: ['GET /scim/v2/accounts/:accountId/ServiceProviderConfig'],
  },
  async (ctx) => {
    // Cross-tenant: a SCIM token minted for team A must not work against team B's
    // URL — scimAuth returns 403 when the token's account != the URL accountId.
    const teamA = await ctx.fixtures.team({ enterprise: true });
    const teamB = await ctx.fixtures.team();
    let scimA: Client;

    await ctx.step('mint SCIM token for team A', async () => {
      scimA = ctx.client.withBearer(await mintScimToken(ctx, teamA.id), 'SCIM-A');
    });

    await ctx.step('team A token against team B URL → 403', async () => {
      const r = await scimA.get('/scim/v2/accounts/:accountId/ServiceProviderConfig', {
        params: { accountId: teamB.id },
      });
      r.status(403).body().exists('$.detail');
    });

    await ctx.step('garbage bearer → 401', async () => {
      const r = await ctx.client
        .withBearer('kortix_scim_totally-bogus-token', 'BOGUS')
        .get('/scim/v2/accounts/:accountId/ServiceProviderConfig', {
          params: { accountId: teamA.id },
        });
      r.status(401);
    });
  },
);

flow(
  'SCIM-5',
  {
    domain: 'scim',
    routes: [
      'GET /scim/v2/accounts/:accountId/ResourceTypes/:id',
      'GET /scim/v2/accounts/:accountId/Schemas/:id',
      'PUT /scim/v2/accounts/:accountId/Users/:userId',
    ],
  },
  async (ctx) => {
    // Single-resource discovery (ResourceTypes/:id, Schemas/:id) — Azure AD
    // fetches these by id after the plain list (SCIM-1). Then PUT (Okta's "Push
    // Profile Updates") full-replaces a REAL created User (not the unknown-id
    // idempotent case SCIM-2 already covers).
    const team = await ctx.fixtures.team({ enterprise: true });
    let scim: Client;

    await ctx.step('mint SCIM token', async () => {
      scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
    });

    await ctx.step('ResourceTypes/User → 200 with endpoint + schema', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/ResourceTypes/:id', {
        params: { accountId: team.id, id: 'User' },
      });
      r.status(200)
        .body()
        .has('$.id', 'User')
        .has('$.endpoint', '/Users')
        .has('$.schema', 'urn:ietf:params:scim:schemas:core:2.0:User');
    });

    await ctx.step('ResourceTypes/:id unknown → 404 SCIM error', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/ResourceTypes/:id', {
        params: { accountId: team.id, id: 'Bogus' },
      });
      r.status(404).body().exists('$.detail');
    });

    await ctx.step('Schemas/:id (core User urn) → 200 with attributes', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Schemas/:id', {
        params: { accountId: team.id, id: 'urn:ietf:params:scim:schemas:core:2.0:User' },
      });
      r.status(200)
        .body()
        .has('$.id', 'urn:ietf:params:scim:schemas:core:2.0:User')
        .exists('$.attributes');
    });

    await ctx.step('Schemas/:id unknown → 404 SCIM error', async () => {
      const r = await scim.get('/scim/v2/accounts/:accountId/Schemas/:id', {
        params: { accountId: team.id, id: 'urn:ietf:params:scim:schemas:core:2.0:Bogus' },
      });
      r.status(404).body().exists('$.detail');
    });

    let userId = '';
    await ctx.step(
      'POST Users for an unknown email → 201 invite (create the real user to PUT)',
      async () => {
        const userName = `${ctx.fixtures.name('scim-put-user')}@ke2e.kortix.test`;
        const r = await scim.post(
          '/scim/v2/accounts/:accountId/Users',
          { userName, externalId: 'ext-ke2e-put-1' },
          { params: { accountId: team.id } },
        );
        r.status(201).body().has('$.active', true);
        userId = r.json<any>().id;
      },
    );

    await ctx.step(
      'PUT full-replace with active:false → 200, actually deactivates (not idempotent 204 on an unknown id)',
      async () => {
        const r = await scim.put(
          '/scim/v2/accounts/:accountId/Users/:userId',
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'ke2e-put-replaced@ke2e.kortix.test',
            active: false,
          },
          { params: { accountId: team.id, userId } },
        );
        // The pending invite is revoked by this PUT — 200 + active:false confirms
        // the write landed (distinct from SCIM-2's PUT-on-unknown-id → 204 case).
        r.status(200).body().has('$.active', false);
      },
    );

    await ctx.step('DELETE the now-revoked invite → idempotent 204 (cleanup)', async () => {
      const r = await scim.del('/scim/v2/accounts/:accountId/Users/:userId', {
        params: { accountId: team.id, userId },
      });
      r.status(204);
    });
  },
);

flow('SCIM-6', {
  domain: 'scim',
  routes: [
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'PUT /scim/v2/accounts/:accountId/Users/:userId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');

  for (const [label, operations] of [
    ['Entra string False', [{ op: 'Replace', path: 'active', value: 'False' }]],
    ['RFC pathless object', [{ op: 'replace', value: { active: false } }]],
    ['case-insensitive attribute', [{ op: 'Replace', path: 'Active', value: false }]],
  ] as const) {
    await ctx.step(`${label} deactivates a provisioned member and read-back retains its inactive state`, async () => {
      const user = await ctx.fixtures.user();
      const params = { accountId: team.id, userId: user.userId! };
      const created = await scim.post('/scim/v2/accounts/:accountId/Users', {
        userName: user.email!, externalId: ctx.fixtures.name('entra-user'),
      }, { params });
      created.status(201).body().has('$.active', true);
      const patched = await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: operations,
      }, { params });
      patched.status(200).body().has('$.active', false);
      (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(200).body().has('$.active', false);
    });
  }

  await ctx.step('Entra string False cannot deactivate the last owner', async () => {
    const params = { accountId: team.id, userId: ctx.P.OWNER.userId! };
    const r = await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    }, { params });
    r.status(409);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params }))
      .status(200).body().has('$.active', true);
  });

  await ctx.step('PUT applies case-insensitive active attributes and Entra string booleans', async () => {
    const user = await ctx.fixtures.user();
    const params = { accountId: team.id, userId: user.userId! };
    (await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: user.email!,
    }, { params })).status(201);
    (await scim.put('/scim/v2/accounts/:accountId/Users/:userId', {
      userName: user.email!, Active: 'False',
    }, { params })).status(200).body().has('$.active', false);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(200).body().has('$.active', false);
  });

  await ctx.step('pathless active update deactivates a pending invitation', async () => {
    const created = await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: `${ctx.fixtures.name('entra-pending')}@ke2e.kortix.test`,
    }, { params: { accountId: team.id } });
    created.status(201);
    const params = { accountId: team.id, userId: created.json<{ id: string }>().id };
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', value: { active: false } }],
    }, { params })).status(200).body().has('$.active', false);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(200).body().has('$.active', false);
  });
});

flow('SCIM-7', {
  domain: 'scim',
  routes: [
    'POST /scim/v2/accounts/:accountId/Groups',
    'GET /scim/v2/accounts/:accountId/Groups/:groupId',
    'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
    'DELETE /scim/v2/accounts/:accountId/Groups/:groupId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const first = await team.addMember('member');
  const second = await team.addMember('member');
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  let groupId = '';

  await ctx.step('provision a group containing two real members', async () => {
    const r = await scim.post('/scim/v2/accounts/:accountId/Groups', {
      displayName: ctx.fixtures.name('entra-members'),
      members: [{ value: first.userId! }, { value: second.userId! }],
    }, { params: { accountId: team.id } });
    r.status(201).body().has('$.members.length', 2);
    groupId = r.json<{ id: string }>().id;
  });

  await ctx.step('Entra Remove members with a value array removes only the named member', async () => {
    const params = { accountId: team.id, groupId };
    const r = await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Remove', path: 'members', value: [{ value: first.userId! }] }],
    }, { params });
    r.status(200).body().has('$.members', [{ value: second.userId! }]);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', [{ value: second.userId! }]);
  });

  await ctx.step('an empty removal array preserves the remaining member', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Remove', path: 'members', value: [] }],
    }, { params: { accountId: team.id, groupId } }))
      .status(200).body().has('$.members', [{ value: second.userId! }]);
  });

  await ctx.step('filtered RFC removal removes the remaining member', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'remove', path: `members[value eq "${second.userId!}"]` }],
    }, { params: { accountId: team.id, groupId } }))
      .status(200).body().has('$.members', []);
  });

  await ctx.step('malformed removal preserves membership and a bare removal clears it', async () => {
    const params = { accountId: team.id, groupId };
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'add', path: 'members', value: [{ value: first.userId! }] }],
    }, { params })).status(200).body().has('$.members', [{ value: first.userId! }]);
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Remove', path: 'members', value: { value: first.userId! } }],
    }, { params })).status(400);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', [{ value: first.userId! }]);
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Remove', path: 'members' }],
    }, { params })).status(200).body().has('$.members', []);
  });

  await ctx.step('delete the test group and confirm it is absent', async () => {
    const params = { accountId: team.id, groupId };
    (await scim.del('/scim/v2/accounts/:accountId/Groups/:groupId', { params })).status(204);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params })).status(404);
  });
});

flow('SCIM-8', {
  domain: 'scim',
  routes: [
    'GET /v1/accounts',
    'PUT /v1/accounts/:accountId/iam/sso/provider',
    'POST /v1/accounts/:accountId/iam/sso/mappings',
    'POST /v1/accounts/:accountId/iam/groups',
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Groups/:groupId',
    'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const user = await ctx.fixtures.user();
  const owner = ctx.client.as(ctx.P.OWNER);
  const providerId = crypto.randomUUID();
  const claim = ctx.fixtures.name('engineering');
  const params = { accountId: team.id, groupId: '' };
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  let oldWithoutGroup: Client;
  let oldWithGroup: Client;

  await ctx.step('configure SSO and map an existing manual group, as in the Azure test tenant', async () => {
    (await owner.put('/v1/accounts/:accountId/iam/sso/provider', {
      supabase_sso_provider_id: providerId,
      name: 'Entra regression',
      primary_domain: `${ctx.fixtures.name('sso-scim')}.test`,
      group_claim_name: 'memberOf',
      auto_create_members: true,
      auto_provision_groups: true,
    }, { params })).status(200);
    const created = await owner.post('/v1/accounts/:accountId/iam/groups', { name: claim }, { params });
    created.status(201);
    params.groupId = created.json<{ group_id: string }>().group_id;
    (await owner.post('/v1/accounts/:accountId/iam/sso/mappings', {
      claim_value: claim, group_id: params.groupId,
    }, { params })).status(201);
    (await scim.post('/scim/v2/accounts/:accountId/Users', { userName: user.email! }, { params }))
      .status(201);
    oldWithoutGroup = ctx.client.withBearer(await ssoFixtureToken(ctx.env, user, providerId, []), 'SSO-before-add');
  });

  await ctx.step('a stale SSO token cannot remove membership added by SCIM', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'add', path: 'members', value: [{ value: user.userId! }] }],
    }, { params })).status(200).body().has('$.members', [{ value: user.userId! }]);
    (await oldWithoutGroup.get('/v1/accounts')).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', [{ value: user.userId! }]);
  });

  await ctx.step('a stale SSO token cannot restore membership removed by SCIM', async () => {
    oldWithGroup = ctx.client.withBearer(await ssoFixtureToken(ctx.env, user, providerId, [claim]), 'SSO-before-remove');
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'remove', path: 'members', value: [{ value: user.userId! }] }],
    }, { params })).status(200).body().has('$.members', []);
    (await oldWithGroup.get('/v1/accounts')).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', []);
  });

  await ctx.step('Entra pathless group attributes persist and retries keep the same resource', async () => {
    for (let retry = 0; retry < 2; retry++) {
      (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
        Operations: [{ op: 'Replace', value: { externalId: providerId, displayName: `${claim}-renamed` } }],
      }, { params })).status(200).body().has('$.externalId', providerId).has('$.displayName', `${claim}-renamed`);
    }
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.id', params.groupId).has('$.externalId', providerId);
  });
});

flow('SCIM-9', {
  domain: 'scim',
  routes: [
    'GET /v1/accounts/:accountId',
    'PUT /v1/accounts/:accountId/iam/sso/provider',
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'DELETE /scim/v2/accounts/:accountId/Users/:userId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const user = await ctx.fixtures.user();
  const params = { accountId: team.id, userId: user.userId! };
  const providerId = crypto.randomUUID();
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  let sso: Client;

  await ctx.step('provision an SSO member with automatic JIT membership enabled', async () => {
    (await ctx.client.as(ctx.P.OWNER).put('/v1/accounts/:accountId/iam/sso/provider', {
      supabase_sso_provider_id: providerId, name: 'Entra lifecycle',
      primary_domain: `${ctx.fixtures.name('scim-lifecycle')}.test`,
      auto_create_members: true,
    }, { params })).status(200);
    (await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: user.email!, externalId: providerId,
    }, { params })).status(201);
    sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, user, providerId, []), 'SSO-deprovision');
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
  });

  await ctx.step('SCIM deactivation prevents an existing SSO token from recreating account access', async () => {
    const [deactivated] = await Promise.all([
      scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }, { params }),
      ...Array.from({ length: 8 }, () => sso.get('/v1/accounts/:accountId', { params })),
    ]);
    deactivated!.status(200).body().has('$.active', false);
    (await sso.get('/v1/accounts/:accountId', { params })).status(403);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params }))
      .status(200).body().has('$.active', false).has('$.externalId', providerId);
  });

  await ctx.step('SCIM reactivation restores the same resource and explicit membership only', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    }, { params })).status(200).body().has('$.id', user.userId!).has('$.active', true);
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
  });

  await ctx.step('DELETE is idempotent and SSO cannot restore a deleted directory user', async () => {
    for (let retry = 0; retry < 2; retry++) {
      (await scim.del('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(204);
    }
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(404);
    (await sso.get('/v1/accounts/:accountId', { params })).status(403);
  });

  await ctx.step('an explicit SCIM create re-provisions the same identity after deletion', async () => {
    (await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: user.email!, externalId: providerId, active: true,
    }, { params })).status(201).body().has('$.id', user.userId!).has('$.active', true);
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
  });
});

flow('SCIM-10', {
  domain: 'scim',
  routes: [
    'PUT /v1/accounts/:accountId/iam/sso/provider',
    'GET /v1/accounts/:accountId',
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'POST /scim/v2/accounts/:accountId/Groups',
    'GET /scim/v2/accounts/:accountId/Groups/:groupId',
    'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const params = { accountId: team.id };
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  const providerId = crypto.randomUUID();
  const email = `${ctx.fixtures.name('scim-first-login')}@ke2e.kortix.test`;
  let scimId: string;
  let groupId: string;
  let sso: Client;

  await ctx.step('provision a pending user with an external ID and include its stable ID in group read-back', async () => {
    (await ctx.client.as(ctx.P.OWNER).put('/v1/accounts/:accountId/iam/sso/provider', {
      supabase_sso_provider_id: providerId, name: 'Entra before login',
      primary_domain: `${ctx.fixtures.name('scim-first-login')}.test`, auto_create_members: false,
    }, { params })).status(200);
    const user = await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: email, externalId: providerId, displayName: 'Before login',
    }, { params });
    user.status(201).body().has('$.externalId', providerId).has('$.displayName', 'Before login');
    scimId = user.json<{ id: string }>().id;
    const group = await scim.post('/scim/v2/accounts/:accountId/Groups', {
      displayName: ctx.fixtures.name('scim-first-login'), members: [{ value: scimId }],
    }, { params });
    group.status(201).body().has('$.members', [{ value: scimId }]);
    groupId = group.json<{ id: string }>().id;
  });

  await ctx.step('first SSO login consumes the pending grant without changing the SCIM user ID', async () => {
    const user = await ctx.fixtures.userWithEmail(email);
    sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, user, providerId, []), 'SSO-first-login');
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', {
      params: { ...params, userId: scimId },
    })).status(200).body().has('$.id', scimId).has('$.externalId', providerId);
    (await scim.get('/scim/v2/accounts/:accountId/Users', {
      params, query: { filter: `userName eq "${email}"` },
    })).status(200).body().has('$.totalResults', 1).has('$.Resources[0].id', scimId);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId },
    })).status(200).body().has('$.members', [{ value: scimId }]);
  });

  await ctx.step('disabled JIT denies unprovisioned SSO users and inactive SCIM users before first login', async () => {
    const outsider = await ctx.fixtures.user();
    const denied = ctx.client.withBearer(await ssoFixtureToken(ctx.env, outsider, providerId, []), 'SSO-unprovisioned');
    (await denied.get('/v1/accounts/:accountId', { params })).status(403);
    (await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: outsider.email!, active: false,
    }, { params })).status(201).body().has('$.active', false);
    (await denied.get('/v1/accounts/:accountId', { params })).status(403);
  });

  await ctx.step('cached SCIM IDs support repeated group removal and re-addition after first login', async () => {
    for (const op of ['remove', 'remove', 'add', 'add']) {
      (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
        Operations: [{ op, path: 'members', value: [{ value: scimId }] }],
      }, { params: { ...params, groupId } })).status(200).body()
        .has('$.members', op === 'add' ? [{ value: scimId }] : []);
    }
  });

  await ctx.step('renaming then deactivating a directory user still blocks its older SSO identity', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', value: { userName: `renamed-${email}`, active: false, displayName: 'Renamed' } }],
    }, { params: { ...params, userId: scimId } })).status(200).body()
      .has('$.id', scimId).has('$.active', false).has('$.displayName', 'Renamed');
    (await sso.get('/v1/accounts/:accountId', { params })).status(403);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId },
    })).status(200).body().has('$.members', [{ value: scimId }]);
  });

  await ctx.step('reactivation preserves directory group membership without a second group push', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    }, { params: { ...params, userId: scimId } })).status(200).body().has('$.active', true);
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId },
    })).status(200).body().has('$.members', [{ value: scimId }]);
  });

});

flow('SCIM-11', {
  domain: 'scim',
  routes: [
    'POST /scim/v2/accounts/:accountId/Groups',
    'GET /scim/v2/accounts/:accountId/Groups/:groupId',
    'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
    'PUT /scim/v2/accounts/:accountId/Groups/:groupId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  const created = await scim.post('/scim/v2/accounts/:accountId/Groups', {
    displayName: ctx.fixtures.name('scim-atomic'), members: [{ value: ctx.P.OWNER.userId! }],
  }, { params: { accountId: team.id } });
  created.status(201);
  const group = created.json<{ id: string; displayName: string }>();
  const params = { accountId: team.id, groupId: group.id };

  await ctx.step('a malformed second operation rolls back an earlier valid group rename', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [
        { op: 'replace', path: 'displayName', value: `${group.displayName}-changed` },
        { op: 'remove', path: 'members', value: [{ display: 'missing value' }] },
      ],
    }, { params })).status(400);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.displayName', group.displayName).has('$.members', [{ value: ctx.P.OWNER.userId! }]);
  });

  await ctx.step('case-insensitive replace-members and pathless add persist exactly the supplied members', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Replace', path: 'Members', value: [] }],
    }, { params })).status(200).body().has('$.members', []);
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'Add', value: { members: [{ value: ctx.P.OWNER.userId! }] } }],
    }, { params })).status(200).body().has('$.members', [{ value: ctx.P.OWNER.userId! }]);
  });

  await ctx.step('unknown user references reject the whole update and duplicate group names return 409', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'replace', path: 'members', value: [{ value: ctx.P.OWNER.userId! }, { value: crypto.randomUUID() }] }],
    }, { params })).status(400);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', [{ value: ctx.P.OWNER.userId! }]);
    (await scim.post('/scim/v2/accounts/:accountId/Groups', { displayName: group.displayName }, { params })).status(409);
  });

  await ctx.step('malformed and unsupported operations fail without changing group state', async () => {
    for (const body of [{}, { Operations: 'bad' }, { Operations: [null] },
      { Operations: [{ op: 'replace', path: 'members', value: [{}] }] },
      { Operations: [{ op: 'remove', path: 'members[broken]' }] },
      { Operations: [{ op: 'replace', path: 'unsupported', value: 1 }] }]) {
      (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', body, { params })).status(400);
    }
    (await scim.put('/scim/v2/accounts/:accountId/Groups/:groupId', { members: [{}] }, { params })).status(400);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', { params }))
      .status(200).body().has('$.members', [{ value: ctx.P.OWNER.userId! }]);
  });
});

flow('SCIM-12', {
  domain: 'scim',
  routes: [
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'GET /scim/v2/accounts/:accountId/Groups',
    'POST /scim/v2/accounts/:accountId/Groups',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  const params = { accountId: team.id };
  const email = `${ctx.fixtures.name('scim-profile')}@ke2e.kortix.test`;
  const created = await scim.post('/scim/v2/accounts/:accountId/Users', {
    userName: email, active: false, name: { givenName: 'Before', familyName: 'Sync' },
  }, { params });
  created.status(201).body().has('$.active', false);
  const userId = created.json<{ id: string }>().id;

  await ctx.step('Entra name subattributes and filtered work-email updates persist through read-back', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [
        { op: 'Replace', path: 'name.givenName', value: 'After' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: `work-${email}` },
      ],
    }, { params: { ...params, userId } })).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', {
      params: { ...params, userId },
    })).status(200).body().has('$.name.givenName', 'After').has('$.name.familyName', 'Sync')
      .has('$.emails[0].value', `work-${email}`).has('$.active', false);
  });

  await ctx.step('invalid active and malformed user operations return 400 and leave inactive state unchanged', async () => {
    for (const body of [{}, { Operations: null }, { Operations: [] },
      { Operations: [{ op: 'replace', path: 'active', value: 'maybe' }] },
      { Operations: [{ op: 'replace', path: 'name.givenName', value: 4 }] }]) {
      (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', body, {
        params: { ...params, userId },
      })).status(400);
    }
    (await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params: { ...params, userId } }))
      .status(200).body().has('$.active', false).has('$.name.givenName', 'After');
  });

  await ctx.step('SCIM filters accept case-insensitive operators and escaped strings', async () => {
    (await scim.get('/scim/v2/accounts/:accountId/Users', {
      params, query: { filter: `USERNAME EQ "${email.toUpperCase()}"` },
    })).status(200).body().has('$.totalResults', 1).has('$.Resources[0].id', userId);
    const displayName = `${ctx.fixtures.name('quoted')} "group"`;
    const group = await scim.post('/scim/v2/accounts/:accountId/Groups', { displayName }, { params });
    group.status(201);
    (await scim.get('/scim/v2/accounts/:accountId/Groups', {
      params, query: { filter: `displayName eq ${JSON.stringify(displayName)}` },
    })).status(200).body().has('$.totalResults', 1).has('$.Resources[0].id', group.json<{ id: string }>().id);
  });

  await ctx.step('user pagination returns stable non-overlapping pages and count zero returns only the total', async () => {
    for (let i = 0; i < 2; i++) {
      (await scim.post('/scim/v2/accounts/:accountId/Users', {
        userName: `${i}-${email}`,
      }, { params })).status(201);
    }
    const all = (await scim.get('/scim/v2/accounts/:accountId/Users', { params })).json<{ totalResults: number; Resources: { id: string }[] }>();
    for (let i = 0; i < all.totalResults; i++) {
      (await scim.get('/scim/v2/accounts/:accountId/Users', {
        params, query: { startIndex: String(i + 1), count: '1' },
      })).status(200).body().has('$.totalResults', all.totalResults).has('$.startIndex', i + 1)
        .has('$.itemsPerPage', 1).has('$.Resources[0].id', all.Resources[i]!.id);
    }
    (await scim.get('/scim/v2/accounts/:accountId/Users', {
      params, query: { count: '0' },
    })).status(200).body().has('$.totalResults', all.totalResults).has('$.Resources', []);
  });
});

flow('SCIM-13', {
  domain: 'scim',
  routes: [
    'GET /v1/accounts/:accountId',
    'POST /v1/accounts/:accountId/iam/scim/tokens',
    'DELETE /v1/accounts/:accountId/iam/scim/tokens/:tokenId',
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'PUT /scim/v2/accounts/:accountId/Users/:userId',
    'DELETE /scim/v2/accounts/:accountId/Users/:userId',
  ],
}, async (ctx) => {
  const a = await ctx.fixtures.team({ enterprise: true });
  const b = await ctx.fixtures.team({ enterprise: true });
  const user = await ctx.fixtures.user();
  const aToken = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/iam/scim/tokens',
    { name: ctx.fixtures.name('revoke-scim') }, { params: { accountId: a.id } });
  aToken.status(201);
  const credential = aToken.json<{ token_id: string; secret: string }>();
  const scimA = ctx.client.withBearer(credential.secret, 'SCIM-A');
  const scimB = ctx.client.withBearer(await mintScimToken(ctx, b.id), 'SCIM-B');

  await ctx.step('the same identity has independent SCIM state in two accounts', async () => {
    for (const [scim, accountId] of [[scimA, a.id], [scimB, b.id]] as const) {
      (await scim.post('/scim/v2/accounts/:accountId/Users', { userName: user.email! }, {
        params: { accountId },
      })).status(201).body().has('$.id', user.userId!);
    }
    (await scimA.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, { params: { accountId: a.id, userId: user.userId! } })).status(200);
    (await ctx.client.as(user).get('/v1/accounts/:accountId', { params: { accountId: a.id } })).status(403);
    (await ctx.client.as(user).get('/v1/accounts/:accountId', { params: { accountId: b.id } })).status(200);
    (await scimB.get('/scim/v2/accounts/:accountId/Users/:userId', {
      params: { accountId: b.id, userId: user.userId! },
    })).status(200).body().has('$.active', true);
  });

  await ctx.step('POST, PUT and DELETE protect the last account owner', async () => {
    const params = { accountId: a.id, userId: ctx.P.OWNER.userId! };
    (await scimA.post('/scim/v2/accounts/:accountId/Users', {
      userName: ctx.P.OWNER.email!, active: false,
    }, { params })).status(409);
    (await scimA.put('/scim/v2/accounts/:accountId/Users/:userId', { active: false }, { params })).status(409);
    (await scimA.del('/scim/v2/accounts/:accountId/Users/:userId', { params })).status(409);
    (await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId', { params })).status(200);
  });

  await ctx.step('revoking a provisioning token immediately rejects subsequent SCIM requests', async () => {
    (await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/iam/scim/tokens/:tokenId', {
      params: { accountId: a.id, tokenId: credential.token_id },
    })).status(200);
    (await scimA.get('/scim/v2/accounts/:accountId/Users/:userId', {
      params: { accountId: a.id, userId: user.userId! },
    })).status(401);
  });
});

flow('SCIM-15', {
  domain: 'scim',
  routes: [
    'POST /scim/v2/accounts/:accountId/Users',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'GET /scim/v2/accounts/:accountId/ResourceTypes/:id',
    'GET /scim/v2/accounts/:accountId/Schemas',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  const params = { accountId: team.id, userId: '' };
  const enterprise = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
  await ctx.step('create and read back the populated attributes in Entra default mappings', async () => {
    const created = await scim.post('/scim/v2/accounts/:accountId/Users', {
      userName: `${ctx.fixtures.name('entra-profile')}@ke2e.kortix.test`,
      preferredLanguage: 'en-US',
      phoneNumbers: [{ type: 'work', value: '+1 202 555 0100', primary: true }],
      addresses: [{ type: 'work', locality: 'Sarajevo', country: 'BA', postalCode: '71000' }],
      [enterprise]: { department: 'Engineering', employeeNumber: 'SCIM-15', manager: { value: ctx.P.OWNER.userId! } },
    }, { params });
    created.status(201);
    params.userId = created.json<{ id: string }>().id;
    const read = await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params });
    read.status(200).body().has('$.preferredLanguage', 'en-US').has('$.phoneNumbers[0].primary', true)
      .has('$.addresses[0].locality', 'Sarajevo');
    const data = read.json<Record<string, any>>();
    if (data[enterprise]?.department !== 'Engineering' || !data.schemas.includes(enterprise)) throw new Error('Enterprise attributes did not persist');
  });
  await ctx.step('Entra filtered paths and enterprise subattributes persist together', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', { Operations: [
      { op: 'Replace', path: 'phoneNumbers[type eq "mobile"].value', value: '+1 202 555 0101' },
      { op: 'Replace', path: 'addresses[type eq "work"].streetAddress', value: 'Test Street' },
      { op: 'Replace', path: `${enterprise}:department`, value: 'Quality' },
      { op: 'Replace', path: `${enterprise}:manager.value`, value: ctx.P.OWNER.userId! },
    ] }, { params })).status(200);
    const read = await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params });
    read.status(200).body().has('$.phoneNumbers[1].value', '+1 202 555 0101').has('$.addresses[0].streetAddress', 'Test Street');
    if (read.json<Record<string, any>>()[enterprise]?.department !== 'Quality') throw new Error('Department patch did not persist');
  });
  await ctx.step('invalid profile updates roll back and removals preserve unrelated values', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', { Operations: [
      { op: 'replace', path: 'preferredLanguage', value: 'de-DE' },
      { op: 'replace', path: 'phoneNumbers', value: [{ value: 42 }] },
    ] }, { params })).status(400);
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', { Operations: [
      { op: 'remove', path: 'phoneNumbers[type eq "mobile"]' },
      { op: 'remove', path: `${enterprise}:department` },
    ] }, { params })).status(200).body().has('$.preferredLanguage', 'en-US')
      .has('$.phoneNumbers', [{ type: 'work', value: '+1 202 555 0100', primary: true }]);
    const read = await scim.get('/scim/v2/accounts/:accountId/Users/:userId', { params });
    const data = read.json<Record<string, any>>();
    if (data[enterprise]?.department != null || data[enterprise]?.employeeNumber !== 'SCIM-15') throw new Error('Enterprise removal changed unrelated attributes');
  });
  await ctx.step('discovery advertises the supported enterprise extension', async () => {
    (await scim.get('/scim/v2/accounts/:accountId/ResourceTypes/:id', { params: { ...params, id: 'User' } })).status(200)
      .body().has('$.schemaExtensions', [{ schema: enterprise, required: false }]);
    const schemas = await scim.get('/scim/v2/accounts/:accountId/Schemas', { params });
    schemas.status(200);
    if (!schemas.json<{ Resources: Array<{ id: string }> }>().Resources.some(s => s.id === enterprise)) throw new Error('Enterprise schema is absent');
  });
});

flow('SCIM-14', {
  domain: 'scim',
  routes: [
    'PUT /v1/accounts/:accountId/iam/sso/provider',
    'GET /v1/accounts/:accountId',
    'POST /scim/v2/accounts/:accountId/Users',
    'PATCH /scim/v2/accounts/:accountId/Users/:userId',
    'DELETE /scim/v2/accounts/:accountId/Users/:userId',
    'POST /scim/v2/accounts/:accountId/Groups',
    'GET /scim/v2/accounts/:accountId/Groups/:groupId',
    'PATCH /scim/v2/accounts/:accountId/Groups/:groupId',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const params = { accountId: team.id };
  const scim = ctx.client.withBearer(await mintScimToken(ctx, team.id), 'SCIM');
  const email = `${ctx.fixtures.name('inactive-directory')}@ke2e.kortix.test`;
  const providerId = crypto.randomUUID();
  (await ctx.client.as(ctx.P.OWNER).put('/v1/accounts/:accountId/iam/sso/provider', {
    supabase_sso_provider_id: providerId, name: 'Entra inactive groups',
    primary_domain: `${ctx.fixtures.name('inactive-directory')}.test`, auto_create_members: true,
  }, { params })).status(200);
  const created = await scim.post('/scim/v2/accounts/:accountId/Users', { userName: email, active: false }, { params });
  created.status(201);
  const userId = created.json<{ id: string }>().id;
  const groups: string[] = [];
  for (let i = 0; i < 2; i++) {
    const group = await scim.post('/scim/v2/accounts/:accountId/Groups', {
      displayName: ctx.fixtures.name(`inactive-group-${i}`), members: [{ value: userId }],
    }, { params });
    group.status(201).body().has('$.members', [{ value: userId }]);
    groups.push(group.json<{ id: string }>().id);
  }
  const user = await ctx.fixtures.userWithEmail(email);
  const sso = ctx.client.withBearer(await ssoFixtureToken(ctx.env, user, providerId, []), 'SSO-inactive');

  await ctx.step('inactive users keep directory group state without account access, including before first login', async () => {
    (await sso.get('/v1/accounts/:accountId', { params })).status(403);
    (await scim.patch('/scim/v2/accounts/:accountId/Groups/:groupId', {
      Operations: [{ op: 'remove', path: 'members', value: [{ value: userId }] }],
    }, { params: { ...params, groupId: groups[0]! } })).status(200).body().has('$.members', []);
  });

  await ctx.step('reactivation restores only group assignments still present in the directory', async () => {
    (await scim.patch('/scim/v2/accounts/:accountId/Users/:userId', {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    }, { params: { ...params, userId } })).status(200);
    (await sso.get('/v1/accounts/:accountId', { params })).status(200);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId: groups[0]! },
    })).status(200).body().has('$.members', []);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId: groups[1]! },
    })).status(200).body().has('$.members', [{ value: userId }]);
  });

  await ctx.step('deleting a user clears directory groups and a later create cannot restore them', async () => {
    (await scim.del('/scim/v2/accounts/:accountId/Users/:userId', { params: { ...params, userId } })).status(204);
    (await sso.get('/v1/accounts/:accountId', { params })).status(403);
    (await scim.post('/scim/v2/accounts/:accountId/Users', { userName: email, active: true }, { params })).status(201);
    (await scim.get('/scim/v2/accounts/:accountId/Groups/:groupId', {
      params: { ...params, groupId: groups[1]! },
    })).status(200).body().has('$.members', []);
  });
});
