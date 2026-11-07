/**
 * Product feedback. Maps to spec §33 "Feedback" (FB-1). The endpoint persists
 * one row per submission for the authenticated caller and rate limits per
 * user; the CLI submits through the same route and prints the receipt.
 */
import { flow } from '../core/flow';
import { assert } from '../core/expect';
import { CliSandbox } from '../fixtures/cli';
import { loadEnv } from '../core/env';

const VALID = { kind: 'idea', message: 'A sessions --watch flag would save me a loop.' };

/** Tiny structured assert that records into the active step (cli-local's shape). */
function check(description: string, pass: boolean, expected: unknown, actual: unknown): void {
  assert({ kind: 'cli', description, expected, actual, pass });
}

flow(
  'FB-1',
  {
    domain: 'feedback',
    tags: ['smoke'],
    routes: ['POST /v1/feedback', 'POST /v1/workspaces/:projectId/cli-token'],
  },
  async (ctx) => {
    await ctx.step('ANON cannot file feedback → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/feedback', VALID);
      r.status(401);
    });

    await ctx.step('OWNER files feedback → 201 receipt', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/feedback', { ...VALID, source: 'web', context: { session_id: 'sess-fb' } });
      r.status(201)
        .body()
        .has('$.kind', 'idea')
        .has('$.source', 'web')
        .exists('$.id')
        .exists('$.created_at');
    });

    await ctx.step('an agent session files with its project-scoped token → 201, source agent', async () => {
      // The in-sandbox KORTIX_TOKEN is a project-scoped PAT and there is no
      // stored login: the CLI reads the token and the API URL from the env.
      const project = await ctx.fixtures.project();
      const minted = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/workspaces/:projectId/cli-token', { name: ctx.fixtures.name('fb-agent') }, { params: { projectId: project.id } });
      minted.status(201);
      const secret = minted.json<{ secret_key: string }>().secret_key;
      const sb = new CliSandbox('fb1-agent');
      ctx.track('cli-sandbox', sb.cwd);
      try {
        const r = await sb.run(['feedback', 'an unparsed bash line asked under a deny pattern', '--kind', 'bug', '--json'], {
          env: {
            KORTIX_TOKEN: secret,
            KORTIX_API_URL: `${loadEnv().apiUrl.replace(/\/v1$/, '')}/v1`,
            KORTIX_PROJECT_ID: project.id,
            KORTIX_SESSION_ID: 'sess-fb-agent',
          },
        });
        check('exit 0', r.exitCode === 0, 0, `${r.exitCode} ${r.stderr}`);
        const receipt = JSON.parse(r.stdout) as { source?: string; kind?: string };
        check('source agent', receipt.source === 'agent', 'agent', receipt.source);
        check('kind bug', receipt.kind === 'bug', 'bug', receipt.kind);
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('source defaults to cli when the body omits it', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/feedback', { kind: 'bug', message: 'x' });
      r.status(201).body().has('$.source', 'cli');
    });

    await ctx.step('an invalid body is rejected → 400 for each malformed field', async () => {
      const bad = [
        { message: 'missing kind' },
        { kind: 'idea' }, // missing message
        { kind: 'complaint', message: 'unknown kind' },
        { kind: 'idea', message: 'm', source: 'sms' },
        { kind: 'idea', message: '' },
        { kind: 'idea', message: 'x'.repeat(4001) },
        { kind: 'idea', message: 'm', context: { session_id: 'x'.repeat(257) } },
      ];
      // NONMEMBER: validation does not depend on the caller, and the limiter
      // (10/min per user) keeps OWNER's budget for the CLI steps.
      for (const body of bad) {
        const r = await ctx.client.as(ctx.P.NONMEMBER).post('/v1/feedback', body);
        r.status(400);
      }
    });

    await ctx.step('the real CLI files feedback end to end and prints the receipt', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-fb') });
      const sb = new CliSandbox('fb1');
      ctx.track('cli-sandbox', sb.cwd);
      try {
        await sb.login(pat);
        const r = await sb.run([
          'feedback',
          'the doctor output is hard to scan',
          '--kind',
          'friction',
          '--json',
        ]);
        check('exit 0', r.exitCode === 0, 0, `${r.exitCode} ${r.stderr}`);
        const receipt = JSON.parse(r.stdout) as { id?: string; source?: string; kind?: string };
        check('receipt id printed', typeof receipt.id === 'string' && receipt.id.length > 0, true, receipt.id);
        check('source cli', receipt.source === 'cli', 'cli', receipt.source);
        check('kind friction', receipt.kind === 'friction', 'friction', receipt.kind);
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('a flood is rate limited → 429 with Retry-After; another user still passes', async () => {
      // The limiter is replica-local (10/min per process): a target with N API
      // tasks admits about 10 x N, so flood until any one task refuses.
      let limited = false;
      for (let i = 0; i < 200 && !limited; i++) {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/feedback', {
          kind: 'idea',
          message: `flood ${i}`,
        });
        if (r.statusCode === 429) {
          limited = true;
          r.status(429);
          if (!r.header('retry-after')) throw new Error('429 without Retry-After');
        } else {
          r.status(201);
        }
      }
      if (!limited) throw new Error('no flood ever hit the feedback rate limit');
      const other = await ctx.client.as(ctx.P.NONMEMBER).post('/v1/feedback', {
        kind: 'bug',
        message: 'from another identity',
      });
      other.status(201);
    });
  },
);
