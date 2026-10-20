import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { seedSessionTranscript } from '../fixtures/session-transcript';
import { CliSandbox } from '../fixtures/cli';

flow('SESS-57', {
  domain: 'sessions',
  requires: ['database'],
  routes: ['GET /v1/projects/:projectId/sessions'],
}, async (ctx) => {
  const project = await ctx.fixtures.project();
  const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId! });
  ctx.track('session', sessionId, { projectId: project.id });
  await seedSessionTranscript(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, sessionId, ensureSandbox: false });
  const cli = new CliSandbox('session-list-model');
  try {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('model-list') });
    const login = await cli.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
    if (login.exitCode !== 0) throw new Error(`CLI login failed: ${login.exitCode}`);
    await ctx.step('two real CLI session-list reads agree with the saved conversation model', async () => {
      for (let i = 0; i < 2; i++) {
        const result = await cli.run(['sessions', 'ls', '--project', project.id, '--json']);
        if (result.exitCode !== 0) throw new Error(`session list failed: ${result.exitCode}: ${result.stderr}`);
        const rows: Array<{ session_id: string; model: string | null }> = JSON.parse(result.stdout);
        if (rows.find((row) => row.session_id === sessionId)?.model !== 'kortix/openai/gpt-5.6-sol') throw new Error('CLI model differs from the saved conversation');
      }
    });
  } finally { cli.dispose(); }
});
