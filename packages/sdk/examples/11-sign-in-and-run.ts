/**
 * 11 — Sign a real user in through the SDK, then use the client.
 *
 * Every other example holds a `kortix_pat_…` secret: one shared credential for
 * every visitor, no per-user identity, no per-person revocation. That is right
 * for a CLI or a cron job and wrong for an app with human users.
 *
 * `createKortixAuth` is the other half. It discovers the deployment's GoTrue
 * with ONE unauthenticated call (`GET /v1/auth/config`), signs the user in
 * against it, persists and refreshes the session, and hands you the `getToken`
 * `createKortix` already takes. Two objects, one seam, one client.
 *
 * Run:
 *   KORTIX_API_URL=http://localhost:8008/v1 \
 *     KORTIX_EMAIL=a@b.test KORTIX_PASSWORD=... \
 *     bun run examples/11-sign-in-and-run.ts
 *
 * As an npm consumer (outside this monorepo) the only import line changes:
 *   import { createKortix, createKortixAuth } from '@kortix/sdk';
 * This file imports from '../src/index' instead, so `tsc`/`bun` resolve it
 * against the package's own source without a published build.
 */
import { createKortix, createKortixAuth, KortixAuthError } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const email = process.env.KORTIX_EMAIL;
  const password = process.env.KORTIX_PASSWORD;
  if (!email || !password) {
    console.error('Set KORTIX_EMAIL and KORTIX_PASSWORD and re-run.');
    process.exit(1);
  }

  // No network yet, and no timer: construction is inert.
  const auth = createKortixAuth({ backendUrl });

  // One client, wired to the seam. `auth.getToken` is an arrow-function
  // property, so passing it unbound is safe.
  const kortix = createKortix({ backendUrl, getToken: auth.getToken });

  auth.onChange(({ event, session }) => {
    console.log(`[auth] ${event} ${session?.user?.email ?? '(no session)'}`);
  });

  // Discovery tells you what the deployment supports, which is what a login
  // form needs to render itself.
  const config = await auth.config();
  console.log(`GoTrue: ${config.url}`);
  console.log(`methods: ${config.methods.join(', ')} | providers: ${config.providers.join(', ') || 'none'}`);

  if (!config.methods.includes('password')) {
    console.error('This deployment has password sign-in disabled. Use auth.signInWithOtp().');
    process.exit(1);
  }

  try {
    const session = await auth.signInWithPassword({ email, password });
    console.log(`signed in as ${session.user?.email} (expires_at ${session.expires_at})`);
  } catch (error) {
    if (error instanceof KortixAuthError) {
      // `.code` is first class precisely so callers can branch on it.
      console.error(`sign-in failed [${error.code ?? 'unknown'}]: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // From here it is an ordinary client. The token is cached for 30 s, refreshed
  // lazily when it nears `exp`, and never handed out dead.
  const projects = await kortix.projects.list();
  console.log(`${projects.length} project(s) reachable as this user:\n`);
  for (const project of projects) {
    console.log(`  ${project.project_id}  ${project.name}`);
  }

  await auth.signOut();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
