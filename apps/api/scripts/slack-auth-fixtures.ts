import postgres from 'postgres';

type FixtureUserKey = 'admin' | 'approved' | 'viewer' | 'accountOnly' | 'noAccess' | 'pending';
type State =
  | 'unlinked'
  | 'linked-admin'
  | 'linked-approved'
  | 'linked-viewer'
  | 'linked-account-only'
  | 'linked-no-access'
  | 'linked-pending';

const workspaceId = process.env.SLACK_AUTH_WORKSPACE_ID || 'T07FUFNT3RV';
const slackUserId = process.env.SLACK_AUTH_USER_ID || 'U07G2D722TY';
const accountId = process.env.SLACK_AUTH_FIXTURE_ACCOUNT_ID || '95788432-f5df-4ffe-af9e-0ed4e03cf96e';
const projectId = process.env.SLACK_AUTH_FIXTURE_PROJECT_ID || 'b4a01f33-d46c-4a96-8a1d-0a265e48978f';
const projectName = process.env.SLACK_AUTH_FIXTURE_PROJECT_NAME || 'Slack Auth No Access Project';
const repoUrl = process.env.SLACK_AUTH_FIXTURE_REPO_URL || 'https://github.com/octocat/Spoon-Knife.git';
const password = process.env.SLACK_AUTH_FIXTURE_PASSWORD || 'SlackFixture123!';
const supabaseUrl = (process.env.SUPABASE_URL || 'http://127.0.0.1:54321').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const users: Record<FixtureUserKey, { email: string; accountRole?: 'owner' | 'admin' | 'member'; projectRole?: 'manager' | 'editor' | 'user' }> = {
  admin: { email: 'slack-fixture-admin@kortix.local', accountRole: 'owner' },
  approved: { email: 'slack-fixture-approved@kortix.local', accountRole: 'member', projectRole: 'editor' },
  viewer: { email: 'slack-fixture-viewer@kortix.local', accountRole: 'member', projectRole: 'user' },
  accountOnly: { email: 'slack-fixture-account-only@kortix.local', accountRole: 'member' },
  noAccess: { email: 'slack-fixture-no-access@kortix.local' },
  pending: { email: 'slack-fixture-pending@kortix.local' },
};

const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });

function needEnv() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

async function ensureAuthUser(email: string): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    select id::text from auth.users where lower(email) = lower(${email}) limit 1
  `;
  if (existing[0]?.id) return existing[0].id;

  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { fixture: 'slack-auth' },
    }),
  });

  if (!res.ok) {
    const after = await sql<{ id: string }[]>`
      select id::text from auth.users where lower(email) = lower(${email}) limit 1
    `;
    if (after[0]?.id) return after[0].id;
    throw new Error(`Failed to create ${email}: ${res.status} ${await res.text()}`);
  }

  const body = await res.json() as { id?: string; user?: { id?: string } };
  const id = body.id || body.user?.id;
  if (!id) throw new Error(`Supabase did not return a user id for ${email}`);
  return id;
}

async function ensureBaseRows() {
  await sql`
    insert into kortix.accounts (account_id, name, setup_complete_at, setup_wizard_step)
    values (${accountId}, 'Slack Auth Fixture Account', now(), 99)
    on conflict (account_id) do update
    set name = excluded.name,
        setup_complete_at = coalesce(kortix.accounts.setup_complete_at, excluded.setup_complete_at),
        updated_at = now()
  `;
  await sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, status)
    values (${projectId}, ${accountId}, ${projectName}, ${repoUrl}, 'main', 'active')
    on conflict (project_id) do update
    set account_id = excluded.account_id,
        name = excluded.name,
        repo_url = excluded.repo_url,
        status = 'active',
        updated_at = now()
  `;
  await sql`
    insert into kortix.chat_installs (platform, workspace_id, project_id)
    values ('slack', ${workspaceId}, ${projectId})
    on conflict (platform, workspace_id, project_id) do nothing
  `;
}

async function ensureMembership(userId: string, spec: (typeof users)[FixtureUserKey]) {
  await sql`delete from kortix.project_members where account_id = ${accountId} and project_id = ${projectId} and user_id = ${userId}`;
  await sql`delete from kortix.account_members where account_id = ${accountId} and user_id = ${userId}`;

  if (spec.accountRole) {
    await sql`
      insert into kortix.account_members (user_id, account_id, account_role)
      values (${userId}, ${accountId}, ${spec.accountRole})
      on conflict (user_id, account_id) do update
      set account_role = excluded.account_role
    `;
  }
  if (spec.projectRole) {
    await sql`
      insert into kortix.project_members (account_id, project_id, user_id, project_role, granted_by)
      values (${accountId}, ${projectId}, ${userId}, ${spec.projectRole}, ${userId})
      on conflict (project_id, user_id) do update
      set project_role = excluded.project_role,
          updated_at = now()
    `;
  }
}

async function ensureUsers() {
  const ids = new Map<FixtureUserKey, string>();
  for (const key of Object.keys(users) as FixtureUserKey[]) {
    const id = await ensureAuthUser(users[key].email);
    ids.set(key, id);
    await ensureMembership(id, users[key]);
  }
  return ids;
}

async function linkSlack(userId: string) {
  await sql`
    insert into kortix.chat_user_identities (platform, workspace_id, platform_user_id, user_id, linked_at, revoked_at)
    values ('slack', ${workspaceId}, ${slackUserId}, ${userId}, now(), null)
    on conflict (platform, workspace_id, platform_user_id) do update
    set user_id = excluded.user_id,
        linked_at = now(),
        revoked_at = null
  `;
}

async function unlinkSlack() {
  await sql`
    update kortix.chat_user_identities
    set revoked_at = now()
    where platform = 'slack'
      and workspace_id = ${workspaceId}
      and platform_user_id = ${slackUserId}
      and revoked_at is null
  `;
}

async function deleteOpenRequestsFor(userId: string) {
  await sql`
    update kortix.project_access_requests
    set status = 'rejected',
        reviewed_at = coalesce(reviewed_at, now()),
        updated_at = now()
    where project_id = ${projectId}
      and requester_user_id = ${userId}
      and status = 'pending'
  `;
}

async function ensurePendingRequest(userId: string, email: string) {
  await sql`delete from kortix.account_members where account_id = ${accountId} and user_id = ${userId}`;
  await sql`delete from kortix.project_members where account_id = ${accountId} and project_id = ${projectId} and user_id = ${userId}`;
  await sql`
    insert into kortix.project_access_requests (account_id, project_id, requester_user_id, requester_email, message)
    values (${accountId}, ${projectId}, ${userId}, ${email}, 'Slack auth fixture: pending project access request')
    on conflict do nothing
  `;
}

async function applyState(state: State, ids: Map<FixtureUserKey, string>) {
  if (state === 'unlinked') {
    await unlinkSlack();
    return;
  }

  const keyByState: Record<Exclude<State, 'unlinked'>, FixtureUserKey> = {
    'linked-admin': 'admin',
    'linked-approved': 'approved',
    'linked-viewer': 'viewer',
    'linked-account-only': 'accountOnly',
    'linked-no-access': 'noAccess',
    'linked-pending': 'pending',
  };
  const key = keyByState[state];
  const userId = ids.get(key);
  if (!userId) throw new Error(`Missing fixture user for ${key}`);
  await linkSlack(userId);

  if (state === 'linked-no-access') {
    await deleteOpenRequestsFor(userId);
  }
  if (state === 'linked-pending') {
    await ensurePendingRequest(userId, users.pending.email);
  }
}

async function setPolicy(channelId: string, policy: string) {
  if (!['project_open', 'owner_approval', 'owner_only'].includes(policy)) {
    throw new Error('policy must be project_open, owner_approval, or owner_only');
  }
  await sql`
    insert into kortix.chat_channel_bindings (platform, workspace_id, channel_id, project_id, conversation_policy)
    values ('slack', ${workspaceId}, ${channelId}, ${projectId}, ${policy})
    on conflict (platform, workspace_id, channel_id) do update
    set project_id = excluded.project_id,
        conversation_policy = excluded.conversation_policy,
        picker_ts = null
  `;
}

async function inventory() {
  const data = {
    project: await sql`
      select project_id, account_id, name, repo_url, status
      from kortix.projects where project_id = ${projectId}
    `,
    slackIdentity: await sql`
      select workspace_id, platform_user_id, user_id, linked_at, revoked_at
      from kortix.chat_user_identities
      where platform = 'slack' and workspace_id = ${workspaceId} and platform_user_id = ${slackUserId}
    `,
    users: await sql`
      select u.id::text as user_id,
             u.email,
             am.account_role,
             pm.project_role,
             exists (
               select 1 from kortix.project_access_requests par
               where par.project_id = ${projectId}
                 and par.requester_user_id = u.id
                 and par.status = 'pending'
             ) as pending_request
      from auth.users u
      left join kortix.account_members am on am.user_id = u.id and am.account_id = ${accountId}
      left join kortix.project_members pm on pm.user_id = u.id and pm.project_id = ${projectId}
      where u.email = any(${Object.values(users).map((u) => u.email)})
      order by u.email
    `,
    pendingRequests: await sql`
      select request_id, requester_user_id, requester_email, status, message, created_at
      from kortix.project_access_requests
      where project_id = ${projectId} and status = 'pending'
      order by created_at desc
    `,
    channelBindings: await sql`
      select workspace_id, channel_id, project_id, agent_name, opencode_model, conversation_policy
      from kortix.chat_channel_bindings
      where platform = 'slack' and workspace_id = ${workspaceId}
      order by channel_id
    `,
  };
  console.log(JSON.stringify(data, null, 2));
}

function printHelp() {
  console.log(`Slack auth fixtures

Usage:
  bun apps/api/scripts/slack-auth-fixtures.ts setup
  bun apps/api/scripts/slack-auth-fixtures.ts state <${[
    'unlinked',
    'linked-admin',
    'linked-approved',
    'linked-viewer',
    'linked-account-only',
    'linked-no-access',
    'linked-pending',
  ].join('|')}>
  bun apps/api/scripts/slack-auth-fixtures.ts policy <channel_id> <project_open|owner_approval|owner_only>
  bun apps/api/scripts/slack-auth-fixtures.ts inventory

Workspace: configured by SLACK_AUTH_WORKSPACE_ID or the fixture default
Slack user: configured by SLACK_AUTH_USER_ID or the fixture default
Project: configured by SLACK_AUTH_FIXTURE_PROJECT_ID or the fixture default
Fixture password: set by SLACK_AUTH_FIXTURE_PASSWORD or the local fixture default
`);
}

async function main() {
  needEnv();
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  if (cmd === 'inventory') {
    await inventory();
    return;
  }

  await ensureBaseRows();
  const ids = await ensureUsers();

  if (cmd === 'setup') {
    await ensurePendingRequest(ids.get('pending')!, users.pending.email);
    console.log('Slack auth fixtures ready.');
    printHelp();
    await inventory();
    return;
  }

  if (cmd === 'state') {
    if (!arg1) throw new Error('state is required');
    await applyState(arg1 as State, ids);
    console.log(`Applied Slack fixture state: ${arg1}`);
    await inventory();
    return;
  }

  if (cmd === 'policy') {
    if (!arg1 || !arg2) throw new Error('policy requires <channel_id> <policy>');
    await setPolicy(arg1, arg2);
    console.log(`Set ${arg1} conversation_policy=${arg2}`);
    await inventory();
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
