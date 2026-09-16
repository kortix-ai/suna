import { flow } from '../core/flow';

flow(
  'SEC-30',
  {
    domain: 'secrets',
    routes: [
      'GET /v1/provider-connections',
      'PUT /v1/provider-connections/:provider',
      'DELETE /v1/provider-connections/:provider',
      'POST /v1/provider-connections/:provider/start',
      'DELETE /v1/provider-connections/:provider/connections/:connectionId',
      'POST /v1/provider-connections/:provider/poll',
      'GET /v1/projects/:projectId/personal-providers',
      'PUT /v1/projects/:projectId/personal-providers/:provider',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const stranger = ctx.client.as(ctx.P.NONMEMBER);
    const projects = [await ctx.fixtures.project(), await ctx.fixtures.project()];
    const provider = { provider: 'openai' };
    const key = `personal-provider-test-${Date.now()}`;
    let firstConnectionId = '';
    try {
      await ctx.step(
        'Reject anonymous and account-token access to global user credentials',
        async () => {
          (await ctx.client.as(ctx.P.ANON).get('/v1/provider-connections')).status(401);
          (await ctx.client.as(ctx.P.PAT_ACCT).get('/v1/provider-connections')).status(403);
        },
      );
      await ctx.step('Save a personal key and expose only its metadata to its owner', async () => {
        const saved = await owner.put(
          '/v1/provider-connections/:provider',
          { api_key: key },
          { params: provider },
        );
        saved.status(200);
        saved.body().has('provider_id', 'openai').has('auth_type', 'api_key');
        firstConnectionId = saved.json().connection_id;
        const list = await owner.get('/v1/provider-connections');
        list.status(200);
        if (!list.json().items.some((item: any) => item.provider_id === 'openai'))
          throw new Error('Missing saved provider');
        if (JSON.stringify(list.json()).includes(key) || JSON.stringify(saved.json()).includes(key))
          throw new Error('Credential exposed');
        const other = await stranger.get('/v1/provider-connections');
        other.status(200);
        if (
          other.json().items.some((item: any) => item.connection_id === saved.json().connection_id)
        )
          throw new Error('Cross-user credential exposure');
      });
      await ctx.step(
        'Require explicit use and bind the same personal connection in two projects',
        async () => {
          const ids: string[] = [];
          for (const project of projects) {
            const params = { projectId: project.id, ...provider };
            const before = await owner.get('/v1/projects/:projectId/personal-providers', {
              params,
            });
            before.status(200);
            if (before.json().items.length !== 0) throw new Error('Implicit provider binding');
            (
              await stranger.put(
                '/v1/projects/:projectId/personal-providers/:provider',
                { enabled: true },
                { params },
              )
            ).status(403);
            (
              await owner.put(
                '/v1/projects/:projectId/personal-providers/:provider',
                { enabled: true },
                { params },
              )
            ).status(200);
            const after = await owner.get('/v1/projects/:projectId/personal-providers', { params });
            after.status(200);
            ids.push(
              after.json().items.find((item: any) => item.provider_id === 'openai').connection_id,
            );
          }
          if (ids[0] !== ids[1]) throw new Error('Cross-project use copied the credential');
        },
      );
      await ctx.step(
        'Reject unsupported flows and tampered OAuth handles without saving a credential',
        async () => {
          (
            await owner.post(
              '/v1/provider-connections/:provider/start',
              {},
              { params: { provider: 'unknown-provider' } },
            )
          ).status(400);
          const poll = await owner.post(
            '/v1/provider-connections/:provider/poll',
            { flow_id: 'tampered' },
            { params: { provider: 'codex' } },
          );
          poll.status(200);
          poll.body().has('status', 'expired');
          (
            await owner.put(
              '/v1/provider-connections/:provider',
              { api_key: '' },
              { params: provider },
            )
          ).status(400);
        },
      );
      await ctx.step(
        'Disable one project binding while keeping the other binding and personal credential',
        async () => {
          (
            await owner.put(
              '/v1/projects/:projectId/personal-providers/:provider',
              { enabled: false },
              { params: { projectId: projects[0]!.id, ...provider } },
            )
          ).status(200);
          for (const [index, project] of projects.entries()) {
            const list = await owner.get('/v1/projects/:projectId/personal-providers', {
              params: { projectId: project.id },
            });
            list.status(200);
            if (list.json().items.length !== index)
              throw new Error('Wrong project binding removed');
          }
        },
      );
      await ctx.step(
        'Add a named connection and deduplicate the same credential without exposing its value',
        async () => {
          const body = { api_key: `${key}-second`, create: true, label: 'Work' };
          const saved = await owner.put('/v1/provider-connections/:provider', body, {
            params: provider,
          });
          saved.status(200).body().has('label', 'Work');
          const repeated = await owner.put('/v1/provider-connections/:provider', body, {
            params: provider,
          });
          repeated.status(200).body().has('connection_id', saved.json().connection_id);
          const list = await owner.get('/v1/provider-connections');
          list.status(200);
          if (list.json().items.length !== 2 || JSON.stringify(list.json()).includes(key))
            throw new Error('Invalid private connection pool');
          const ownProject = { projectId: projects[0]!.id, ...provider };
          (
            await owner.put(
              '/v1/projects/:projectId/personal-providers/:provider',
              { enabled: true, connection_id: saved.json().connection_id },
              { params: ownProject },
            )
          ).status(200);
          const selected = await owner.get('/v1/projects/:projectId/personal-providers', {
            params: ownProject,
          });
          selected
            .status(200)
            .body()
            .has('items[0].connection_id', saved.json().connection_id)
            .has('items[0].pool', false);
          (
            await stranger.put(
              '/v1/provider-connections/:provider',
              { api_key: 'foreign-replacement', connection_id: saved.json().connection_id },
              { params: provider },
            )
          ).status(404);
          (
            await stranger.del('/v1/provider-connections/:provider/connections/:connectionId', {
              params: { ...provider, connectionId: saved.json().connection_id },
            })
          ).status(200);
          const unchanged = await owner.get('/v1/provider-connections');
          unchanged.status(200);
          if (unchanged.json().items.length !== 2)
            throw new Error('Another user removed a connection');
        },
      );
      await ctx.step(
        'Enable a private pool explicitly and preserve it when its original connection is removed',
        async () => {
          const params = { projectId: projects[1]!.id, ...provider };
          (
            await owner.put(
              '/v1/projects/:projectId/personal-providers/:provider',
              { enabled: true, pool: true },
              { params },
            )
          ).status(200);
          (
            await owner.put(
              '/v1/projects/:projectId/personal-providers/:provider',
              { enabled: true, pool: true, connection_id: firstConnectionId },
              { params },
            )
          ).status(400);
          (
            await owner.del('/v1/provider-connections/:provider/connections/:connectionId', {
              params: { ...provider, connectionId: firstConnectionId },
            })
          ).status(200);
          const remaining = await owner.get('/v1/provider-connections');
          remaining.status(200);
          if (remaining.json().items.length !== 1)
            throw new Error('Deleting one connection removed its siblings');
          const binding = await owner.get('/v1/projects/:projectId/personal-providers', { params });
          binding
            .status(200)
            .body()
            .has('items[0].pool', true)
            .has('items[0].connection_id', remaining.json().items[0].connection_id);
        },
      );
      await ctx.step(
        'Disconnect the personal provider and revoke every remaining project binding',
        async () => {
          (await owner.del('/v1/provider-connections/:provider', { params: provider })).status(200);
          for (const project of projects) {
            const list = await owner.get('/v1/projects/:projectId/personal-providers', {
              params: { projectId: project.id },
            });
            list.status(200);
            if (list.json().items.length !== 0)
              throw new Error('Disconnected credential still bound');
          }
        },
      );
    } finally {
      await owner.del('/v1/provider-connections/:provider', { params: provider });
    }
  },
);
