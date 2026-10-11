/**
 * Product feedback. Maps to spec §33 "Feedback" (FB-1). The endpoint persists
 * one row per submission for the authenticated caller and rate limits per
 * user; the CLI submits through the same route and prints the receipt.
 */
import { flow } from '../core/flow';
import { assert } from '../core/expect';
import { CliSandbox } from '../fixtures/cli';

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
    routes: ['POST /v1/feedback'],
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
      for (const body of bad) {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/feedback', body);
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
        check('exit 0', r.exitCode === 0, 0, r.exitCode);
        const receipt = JSON.parse(r.stdout) as { id?: string; source?: string; kind?: string };
        check('receipt id printed', typeof receipt.id === 'string' && receipt.id.length > 0, true, receipt.id);
        check('source cli', receipt.source === 'cli', 'cli', receipt.source);
        check('kind friction', receipt.kind === 'friction', 'friction', receipt.kind);
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('a flood is rate limited → 429 with Retry-After; another user still passes', async () => {
      let limited = false;
      for (let i = 0; i < 15 && !limited; i++) {
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
