import { test, expect } from '@playwright/test';
import { installBrowserSession, signIn } from '../helpers/session-auth';

const ownerEmail = process.env.E2E_OWNER_EMAIL || 'test-e2e@kortix.ai';
const ownerPassword = process.env.E2E_OWNER_PASSWORD || 'e2e-testpass-123';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: ownerPassword,
  envFiles: [`${process.env.HOME}/.kortix/.env`, 'apps/web/.env', 'apps/api/.env'],
};

test.describe('04 — Authentication flow', () => {
  test.setTimeout(120_000);

  test('owner can authenticate via Supabase API', async () => {
    const session = await signIn(ownerEmail, authOptions);
    expect(session.access_token).toBeTruthy();
    expect(session.access_token).toMatch(/^eyJ/); // JWT
  });

  test('browser login flow reaches wizard', async ({ page }) => {
    const session = await signIn(ownerEmail, authOptions);
    await installBrowserSession(page, session, '/projects', ownerPassword);

    // Final-review FIX 4: `/projects` redirects now (Task 21), through
    // `/projects/start`, to one of three real outcomes — which one depends
    // on this owner's account state at run time, since `ownerEmail` is a
    // shared, reused CI identity, not a guaranteed-fresh signup:
    //  - an EXISTING project resolves immediately -> the project shell
    //    renders (the sidebar's workspace switcher, `workspace-switcher.tsx`);
    //  - a genuinely first project auto-provisions -> the onboarding wizard
    //    ("Connect a provider") renders on top of that SAME shell;
    //  - nothing resolves and nothing may auto-create (suppressed / blocked /
    //    no permission) -> the terminal empty state renders instead
    //    (`app/(app)/projects/start/landing-terminal.tsx`).
    // The old race's other two anchors named UI this branch deleted (the
    // `Projects` list heading, the `New project`/`Add new project` button) —
    // updated below to the three outcomes that can actually occur today, so
    // this is a real race again instead of one live anchor plus two 30s-long
    // dead timers.
    const wizardHeading = page.getByRole('heading', { name: /Connect a provider/i });
    const workspaceShell = page.getByRole('link', { name: /^(Home|Workspace home)$/ }).first();
    const terminalEmpty = page.getByText(
      /No workspace (yet|open)|Your last workspace is archived/i,
    );
    const visibleShell = await Promise.race([
      wizardHeading.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
      workspaceShell.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
      terminalEmpty.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
    ]);
    expect(visibleShell).toBe(true);
    expect(page.url()).not.toContain('/instances');
    expect(page.url()).not.toContain('/dashboard');
  });
});
