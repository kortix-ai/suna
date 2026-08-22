import { clientFromAuth } from '../api/client.ts';
import {
  emitJson,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { resolveUserId } from '../iam.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';

// `kortix members` — the CLI face of the account member directory:
// `/accounts/:id/members` + `/accounts/:id/invites`.
//
// Membership is TWO facts on the server: the IDENTITY row (who belongs to this
// account, plus the `is_super_admin` bypass flag) and the account-scope ROLE
// assignment. Both move together here, which is why `set-role` is a member
// verb and not a `kortix access grant`.
//
// Project-level access is a different surface: `kortix access` binds roles to
// one project, `kortix groups` binds people to groups. This command only
// covers the account itself.

/** Account roles the API accepts on `PATCH /members/:userId`. */
const ACCOUNT_ROLES = ['owner', 'admin', 'member'] as const;
/** Roles `POST /members` accepts. Anything else is silently coerced to
 *  `member` server-side, so the CLI refuses instead of downgrading quietly. */
const INVITE_ROLES = ['admin', 'member'] as const;

interface MemberRow {
  user_id: string;
  email: string | null;
  account_role: string;
  is_super_admin: boolean;
  explicit_project_count: number;
  projects: Array<{ project_id: string; name: string; role: string }>;
  groups: Array<{ group_id: string; name: string }>;
  active_pat_count: number;
  has_verified_mfa: boolean;
  joined_at: string;
}

interface InviteRow {
  invite_id: string;
  email: string;
  initial_role: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  invite_url: string;
}

interface InviteResult {
  status: 'added' | 'pending';
  user_id?: string;
  invite_id?: string;
  email: string;
  account_role: string;
  project_grants: Array<{ project_id: string; role: string }>;
  expires_at?: string;
  invite_url?: string;
  email_sent?: boolean;
  email_skip_reason?: string | null;
}

const HELP = help`Usage: kortix members <subcommand> [options]

Who belongs to the account, and at what account role. Roles are owner, admin
and member; owners and admins hold implicit Manager on every project, so a
member is the only role that takes per-project grants.

Members:
  ls [--json]                       List members, roles and project counts.
  invite <email> --role <r>         Invite by email. Adds an existing Kortix
                                    user immediately; otherwise mails an
                                    invite link. Needs member.invite.
  set-role <user|email> --role <r>  Change an account role. Needs member.update
                                    (owner-only for the owner role).
  rm <user|email> [-y]              Remove a member and revoke their tokens.
                                    Needs member.remove.
  super-admin <user|email> on|off   Grant/revoke the super-admin bypass.
                                    Needs member.super_admin.grant.

Pending invitations you sent:
  invites ls [--json]               List pending invites (member.invite).
  invites cancel <invite-id>        Cancel one.
  invites resend <invite-id>        Re-send the email, refresh the 14-day expiry.

Options:
  --role <r>          Account role. invite: ${INVITE_ROLES.join('|')}.
                      set-role: ${ACCOUNT_ROLES.join('|')}.
  --project <id>:<r>  Repeatable. Project access to grant alongside a member
                      invite: project roles are manager|member (default
                      member). Applied on accept for a pending invite. Ignored
                      by the server for an admin invite.
  --account <id>      Operate on this account (default: the active account).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output (read subcommands).
  -y, --yes           Skip the confirmation prompt.
  -h, --help          Show this help.

A <user> is a user id, or the email of someone already in the account.

Examples:
  kortix members ls
  kortix members invite alice@corp.com --role member --project 1a2b…:manager
  kortix members set-role alice@corp.com --role admin
  kortix members super-admin alice@corp.com on
  kortix members invites ls
`;

export async function runMembers(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const f: Record<string, string | undefined> = {};
  let projectGrantArgs: string[] = [];
  let json = false;
  let yes = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.role = takeFlagValue(rest, ['--role']);
    projectGrantArgs = takeFlagValues(rest, ['--project']);
    json = takeFlagBool(rest, ['--json']);
    yes = takeFlagBool(rest, ['-y', '--yes']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/accounts/${encodeURIComponent(ctx.accountId)}`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await membersLs(ctx.client, base, json);

      case 'invite':
        return await membersInvite(ctx.client, base, positional[0], f.role, projectGrantArgs, json);

      case 'set-role':
      case 'role':
        return await membersSetRole(ctx.client, ctx.accountId, base, positional[0], f.role, json);

      case 'rm':
      case 'remove':
      case 'delete':
        return await membersRm(ctx.client, ctx.accountId, base, positional[0], yes);

      case 'super-admin':
        return await membersSuperAdmin(
          ctx.client,
          ctx.accountId,
          base,
          positional[0],
          positional[1],
          json,
        );

      case 'invites':
        return await membersInvites(ctx, base, positional, json);

      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── members ls ─────────────────────────────────────────────────────────────

async function membersLs(
  client: ReturnType<typeof clientFromAuth>,
  base: string,
  json: boolean,
): Promise<number> {
  const members = await client.get<MemberRow[]>(`${base}/members`);
  if (json) {
    emitJson(members);
    return 0;
  }
  if (members.length === 0) {
    process.stdout.write(`\n  ${C.dim}No members.${C.reset}\n\n`);
    return 0;
  }
  const label = (m: MemberRow) => m.email ?? m.user_id;
  const emailW = Math.max(...members.map((m) => label(m).length), 5);
  const roleW = Math.max(...members.map((m) => m.account_role.length), 4);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('MEMBER', emailW)}   ${pad('ROLE', roleW)}   ${pad('PROJECTS', 8)}   ${pad('MFA', 3)}   FLAGS${C.reset}\n`,
  );
  for (const m of members) {
    const flags: string[] = [];
    if (m.is_super_admin) flags.push(`${C.yellow}super-admin${C.reset}`);
    if (m.active_pat_count > 0) flags.push(`${C.faded}${m.active_pat_count} key(s)${C.reset}`);
    if (m.groups.length > 0) {
      flags.push(`${C.faded}${m.groups.map((g) => g.name).join(', ')}${C.reset}`);
    }
    process.stdout.write(
      `  ${pad(label(m), emailW)}   ${pad(m.account_role, roleW)}   ` +
        `${pad(String(m.explicit_project_count), 8)}   ${pad(m.has_verified_mfa ? 'yes' : 'no', 3)}   ` +
        `${flags.join(' · ')}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${members.length} member${members.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

// ── members invite ─────────────────────────────────────────────────────────

/** `--project <id>:<role>` → the `project_grants` entry the API expects. */
export function parseProjectGrant(
  raw: string,
): { project_id: string; role: string } | { error: string } {
  const idx = raw.lastIndexOf(':');
  const projectId = idx < 0 ? raw : raw.slice(0, idx);
  const role = idx < 0 ? 'member' : raw.slice(idx + 1);
  if (!projectId) return { error: `--project "${raw}" has no project id` };
  if (!role) return { error: `--project "${raw}" has no role — use <id>:manager or <id>:member` };
  if (role !== 'manager' && role !== 'member') {
    return { error: `--project role must be manager or member (got "${role}")` };
  }
  return { project_id: projectId, role };
}

async function membersInvite(
  client: ReturnType<typeof clientFromAuth>,
  base: string,
  email: string | undefined,
  role: string | undefined,
  projectArgs: string[],
  json: boolean,
): Promise<number> {
  if (!email) return missing('an email address');
  if (!role) return missing(`--role <${INVITE_ROLES.join('|')}>`);
  if (!(INVITE_ROLES as readonly string[]).includes(role)) {
    if (role === 'owner') {
      process.stderr.write(
        `${status.err('An invite cannot grant owner.')} Invite as admin, then ` +
          `${C.cyan}kortix members set-role <email> --role owner${C.reset} once they join.\n`,
      );
      return 2;
    }
    process.stderr.write(`${status.err(`--role must be ${INVITE_ROLES.join(' or ')}.`)}\n`);
    return 2;
  }

  const grants: Array<{ project_id: string; role: string }> = [];
  for (const raw of projectArgs) {
    const parsed = parseProjectGrant(raw);
    if ('error' in parsed) {
      process.stderr.write(`${status.err(parsed.error)}\n`);
      return 2;
    }
    grants.push(parsed);
  }
  if (grants.length > 0 && role !== 'member') {
    process.stdout.write(
      `${status.warn('--project is ignored for an admin invite — admins already manage every project.')}\n`,
    );
  }

  const result = await client.post<InviteResult>(`${base}/members`, {
    email,
    role,
    ...(grants.length > 0 ? { project_grants: grants } : {}),
  });
  if (json) {
    emitJson(result);
    return 0;
  }
  if (result.status === 'added') {
    process.stdout.write(
      `${status.ok(`Added ${C.bold}${result.email}${C.reset} as ${result.account_role} ${C.faded}(${result.user_id})${C.reset}`)}\n`,
    );
  } else {
    process.stdout.write(
      `${status.ok(`Invited ${C.bold}${result.email}${C.reset} as ${result.account_role}`)}\n`,
    );
    if (result.invite_url) {
      process.stdout.write(`  ${C.dim}link    ${C.reset}${result.invite_url}\n`);
    }
    if (result.expires_at) {
      process.stdout.write(`  ${C.dim}expires ${C.reset}${result.expires_at.slice(0, 10)}\n`);
    }
    if (result.email_sent === false) {
      process.stdout.write(
        `${status.warn(`Email not sent${result.email_skip_reason ? `: ${result.email_skip_reason}` : ''} — share the link above.`)}\n`,
      );
    }
  }
  for (const g of result.project_grants ?? []) {
    process.stdout.write(`  ${C.dim}project ${C.reset}${g.project_id} ${C.faded}${g.role}${C.reset}\n`);
  }
  return 0;
}

// ── members set-role / rm / super-admin ────────────────────────────────────

async function membersSetRole(
  client: ReturnType<typeof clientFromAuth>,
  accountId: string,
  base: string,
  who: string | undefined,
  role: string | undefined,
  json: boolean,
): Promise<number> {
  if (!who) return missing('a user id or email');
  if (!role) return missing(`--role <${ACCOUNT_ROLES.join('|')}>`);
  if (!(ACCOUNT_ROLES as readonly string[]).includes(role)) {
    process.stderr.write(`${status.err(`--role must be one of ${ACCOUNT_ROLES.join('|')}.`)}\n`);
    return 2;
  }
  const userId = await resolveUserId(client, accountId, who);
  if (!userId) return 1;

  const result = await client.patch<{
    user_id: string;
    account_role: string;
    unchanged?: boolean;
  }>(`${base}/members/${encodeURIComponent(userId)}`, { role });
  if (json) {
    emitJson(result);
    return 0;
  }
  process.stdout.write(
    result.unchanged
      ? `${status.info(`${who} is already ${result.account_role}.`)}\n`
      : `${status.ok(`${C.bold}${who}${C.reset} → ${result.account_role}`)}\n`,
  );
  return 0;
}

async function membersRm(
  client: ReturnType<typeof clientFromAuth>,
  accountId: string,
  base: string,
  who: string | undefined,
  yes: boolean,
): Promise<number> {
  if (!who) return missing('a user id or email');
  const userId = await resolveUserId(client, accountId, who);
  if (!userId) return 1;

  if (!yes) {
    const ok = await confirm(
      `Remove ${C.bold}${who}${C.reset} from this account? Their API keys and live sessions are revoked immediately.`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  await client.delete(`${base}/members/${encodeURIComponent(userId)}`);
  process.stdout.write(`${status.ok(`Removed ${C.bold}${who}${C.reset}`)}\n`);
  return 0;
}

async function membersSuperAdmin(
  client: ReturnType<typeof clientFromAuth>,
  accountId: string,
  base: string,
  who: string | undefined,
  state: string | undefined,
  json: boolean,
): Promise<number> {
  if (!who) return missing('a user id or email');
  if (state !== 'on' && state !== 'off') return missing('on or off');
  const userId = await resolveUserId(client, accountId, who);
  if (!userId) return 1;

  const result = await client.patch<{ user_id: string; is_super_admin: boolean }>(
    `${base}/iam/members/${encodeURIComponent(userId)}/super-admin`,
    { isSuperAdmin: state === 'on' },
  );
  if (json) {
    emitJson(result);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${who}${C.reset} super-admin ${result.is_super_admin ? 'on' : 'off'}`)}\n`,
  );
  if (result.is_super_admin) {
    process.stdout.write(
      `  ${C.dim}Super-admin bypasses every permission check in this account, and MFA enforcement.${C.reset}\n`,
    );
  }
  return 0;
}

// ── members invites ────────────────────────────────────────────────────────

async function membersInvites(
  ctx: NonNullable<ReturnType<typeof resolveAccountContext>>,
  base: string,
  positional: string[],
  json: boolean,
): Promise<number> {
  const verb = positional[0];
  const id = positional[1];
  switch (verb) {
    case undefined:
    case 'ls':
    case 'list': {
      const invites = await ctx.client.get<InviteRow[]>(`${base}/invites`);
      if (json) {
        emitJson(invites);
        return 0;
      }
      if (invites.length === 0) {
        process.stdout.write(`\n  ${C.dim}No pending invites.${C.reset}\n\n`);
        return 0;
      }
      const emailW = Math.max(...invites.map((i) => i.email.length), 5);
      process.stdout.write('\n');
      process.stdout.write(
        `  ${C.dim}${pad('EMAIL', emailW)}   ${pad('ROLE', 6)}   ${pad('EXPIRES', 10)}   INVITE ID${C.reset}\n`,
      );
      for (const i of invites) {
        process.stdout.write(
          `  ${pad(i.email, emailW)}   ${pad(i.initial_role, 6)}   ${pad(i.expires_at.slice(0, 10), 10)}   ${C.faded}${i.invite_id}${C.reset}\n`,
        );
      }
      process.stdout.write(
        `\n  ${C.dim}${invites.length} pending invite${invites.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      return 0;
    }

    case 'cancel': {
      if (!id) return missing('an invite id (see `kortix members invites ls`)');
      await ctx.client.delete(`${base}/invites/${encodeURIComponent(id)}`);
      process.stdout.write(`${status.ok(`Cancelled invite ${C.bold}${id}${C.reset}`)}\n`);
      return 0;
    }

    case 'resend': {
      if (!id) return missing('an invite id (see `kortix members invites ls`)');
      const result = await ctx.client.post<{
        ok: boolean;
        expires_at: string;
        invite_url: string;
        email_sent: boolean;
        email_skip_reason: string | null;
      }>(`${base}/invites/${encodeURIComponent(id)}/resend`, {});
      if (json) {
        emitJson(result);
        return 0;
      }
      process.stdout.write(
        `${status.ok(`Re-sent invite ${C.bold}${id}${C.reset} — expires ${result.expires_at.slice(0, 10)}`)}\n`,
      );
      process.stdout.write(`  ${C.dim}link ${C.reset}${result.invite_url}\n`);
      if (!result.email_sent) {
        process.stdout.write(
          `${status.warn(`Email not sent${result.email_skip_reason ? `: ${result.email_skip_reason}` : ''} — share the link above.`)}\n`,
        );
      }
      return 0;
    }

    default:
      process.stderr.write(
        `${status.err(`unknown invites verb "${verb}" — use ls|cancel|resend`)}\n`,
      );
      return 2;
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
