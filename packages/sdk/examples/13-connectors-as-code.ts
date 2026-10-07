/**
 * 13 — Project connectors as code: one handle per connector, typed errors,
 * pagination. Three callers, one API:
 *
 *   (a) a browser App shows its viewer's own data, or a Connect button;
 *   (b) an unattended sync (a Convex action, a cron, an App server job) pages
 *       through a list and backs off on a rate limit;
 *   (c) an external script with a PAT inspects a connector and runs one action.
 *
 * `kortix connectors types --out kortix-connectors.d.ts` types every `run`,
 * `call` and `paginate` below (args checked, output typed). Without it, args
 * are any object and outputs are `unknown`.
 *
 * Run (c) — read-only unless the action you name writes:
 *   KORTIX_API_URL=http://localhost:8008/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=<project-id> KORTIX_CONNECTOR=github \
 *   KORTIX_ACTION=<action> KORTIX_ARGS='{"per_page":5}' \
 *   bun run examples/13-connectors-as-code.ts
 *
 * Run (b) — pages through KORTIX_ACTION, following `KORTIX_CURSOR_FIELD` of each
 * page into the next request's `KORTIX_CURSOR_ARG`:
 *   MODE=sync KORTIX_CURSOR_FIELD=next_cursor KORTIX_CURSOR_ARG=cursor ... \
 *   bun run examples/13-connectors-as-code.ts
 *
 * (a) runs only inside a Kortix-hosted App with `viewer_token_scope: 'api'`;
 * see `viewerInbox` below.
 *
 * As an npm consumer the only import line changes:
 *   import { createKortix, kortixAppViewerToken, ConnectorCallError,
 *     ConnectorApprovalPendingError } from '@kortix/sdk';
 * React Apps read the same call as a cached query:
 *   import { useConnectorQuery } from '@kortix/sdk/react';
 *   const { data, error } = useConnectorQuery(projectId, 'gmail', 'fetch_emails', { max_results: 10 });
 */
import {
  ConnectorApprovalPendingError,
  ConnectorCallError,
  createKortix,
  kortixAppViewerToken,
} from '../src/index';

// ── (a) A browser App, as its viewer ────────────────────────────────────────
//
// The App gate serves the Kortix API on the App's own origin at
// `/_kortix/api/v1` and attaches the viewer's token. Every call runs as the
// person looking at the App, with their accounts and their permissions.
export async function viewerInbox(projectId: string): Promise<
  { kind: 'rows'; rows: unknown } | { kind: 'connect'; url: string } | { kind: 'pick'; accounts: string[] }
> {
  const kortix = createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() });
  try {
    const rows = await kortix.project(projectId).connector('gmail').run('fetch_emails', { max_results: 10 });
    return { kind: 'rows', rows };
  } catch (error) {
    if (error instanceof ConnectorCallError && error.connectUrl) return { kind: 'connect', url: error.connectUrl };
    if (error instanceof ConnectorCallError && error.code === 'account_required') {
      return { kind: 'pick', accounts: error.availableAccounts };
    }
    throw error;
  }
}

// ── (b) An unattended sync ──────────────────────────────────────────────────
//
// In a Convex action the token comes from the deployment's env
// (`npx convex env set KORTIX_API_KEY ...`), never from the bundle.
export async function syncAll(options: {
  backendUrl: string;
  token: string;
  projectId: string;
  connector: string;
  action: string;
  args: Record<string, unknown>;
  cursorField: string;
  cursorArg: string;
  onPage: (page: unknown) => Promise<void> | void;
}): Promise<number> {
  const kortix = createKortix({ backendUrl: options.backendUrl, getToken: async () => options.token });
  const connector = kortix.project(options.projectId).connector(options.connector);
  let pages = 0;
  let args = options.args;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      for await (const page of connector.paginate(options.action, args, {
        maxPages: 50,
        next: (output, current) => {
          const cursor = (output as Record<string, unknown> | null)?.[options.cursorField];
          return typeof cursor === 'string' && cursor ? { ...current, [options.cursorArg]: cursor } : undefined;
        },
      })) {
        await options.onPage(page);
        pages += 1;
        const cursor = (page as Record<string, unknown> | null)?.[options.cursorField];
        if (typeof cursor === 'string' && cursor) args = { ...options.args, [options.cursorArg]: cursor };
      }
      return pages;
    } catch (error) {
      // A rate limit is the one error worth waiting out: resume from the last
      // cursor after the upstream's Retry-After. Everything else needs a human.
      if (!(error instanceof ConnectorCallError) || error.upstreamStatus !== 429) throw error;
      await new Promise((resolve) => setTimeout(resolve, (error.retryAfterSeconds ?? 5) * 1000));
    }
  }
  throw new Error(`${options.connector}.${options.action}: still rate limited after 3 attempts`);
}

// ── (c) An external script with a PAT ───────────────────────────────────────
async function runOnce(backendUrl: string, apiKey: string, projectId: string): Promise<void> {
  const slug = process.env.KORTIX_CONNECTOR ?? 'github';
  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const connector = kortix.project(projectId).connector(slug);

  const described = await connector.describe();
  if (!described) {
    console.error(`${slug} is not callable in this project.`);
    process.exit(1);
  }
  console.log(`${slug}: ${described.actions.length} actions`);
  for (const account of await connector.accounts()) {
    console.log(`  account ${account.label}${account.is_default ? ' (default)' : ''}`);
  }

  const action = process.env.KORTIX_ACTION;
  if (!action) {
    for (const entry of described.actions.slice(0, 20)) console.log(`  ${entry.path} [${entry.risk}]`);
    console.log('Set KORTIX_ACTION (and KORTIX_ARGS as JSON) to run one.');
    return;
  }
  const schema = await connector.describe(action);
  console.log(`input schema: ${JSON.stringify(schema?.inputSchema ?? null)}`);

  try {
    const output = await connector.run(action, JSON.parse(process.env.KORTIX_ARGS ?? '{}'), {
      approvalContext: 'Example 13 run from a terminal',
    });
    console.log(JSON.stringify(output, null, 2).slice(0, 2000));
  } catch (error) {
    if (error instanceof ConnectorApprovalPendingError) {
      console.log(`Waiting for approval: ${error.approvalUrl ?? error.executionId}`);
    } else if (error instanceof ConnectorCallError) {
      console.error(`${error.status} ${error.code}: ${error.message}`);
      if (error.connectUrl) console.error(`Connect an account: ${error.connectUrl}`);
      if (error.availableAccounts.length) console.error(`Accounts: ${error.availableAccounts.join(', ')}`);
      process.exit(1);
    } else {
      throw error;
    }
  }
}

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const projectId = process.env.KORTIX_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.error('Set KORTIX_API_KEY and KORTIX_PROJECT_ID and re-run.');
    process.exit(1);
  }
  if (process.env.MODE !== 'sync') return runOnce(backendUrl, apiKey, projectId);

  const action = process.env.KORTIX_ACTION;
  if (!action) {
    console.error('MODE=sync needs KORTIX_ACTION.');
    process.exit(1);
  }
  const pages = await syncAll({
    backendUrl,
    token: apiKey,
    projectId,
    connector: process.env.KORTIX_CONNECTOR ?? 'github',
    action,
    args: JSON.parse(process.env.KORTIX_ARGS ?? '{}'),
    cursorField: process.env.KORTIX_CURSOR_FIELD ?? 'next_cursor',
    cursorArg: process.env.KORTIX_CURSOR_ARG ?? 'cursor',
    onPage: (page) => console.log(JSON.stringify(page).slice(0, 200)),
  });
  console.log(`${pages} pages`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
