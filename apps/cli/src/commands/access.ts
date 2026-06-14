import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

type ProjectRole = 'manager' | 'editor' | 'viewer';
const ROLES: readonly ProjectRole[] = ['manager', 'editor', 'viewer'];

interface AccessMember {
  user_id: string;
  email: string | null;
  account_role: string;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
  effective_source: string | null;
  joined_at: string;
  expires_at: string | null;
}

interface PendingInvite {
  invite_id: string;
  email: string;
  project_role: ProjectRole;
  invited_by_email: string | null;
  invite_expired: boolean;
}

const HELP = `Usage: kortix access <subcommand> [options]

Manage who can use the linked project — mirrors the dashboard's project
sharing/access panel. Roles: ${ROLES.join(', ')}.

Subcommands:
  ls [--json]                       List members + effective project roles.
  invite <email> --role <r>         Invite someone to the project.
  grant <user-id> --role <r>        Set/grant a member's project role.
  revoke <user-id>                  Remove a member's project access.
  pending [--json]                  List pending project invitations.
  cancel <invite-id>                Cancel a pending invitation.

Options:
  --role <r>         ${ROLES.join('|')}.
  --expires <iso>    Optional auto-revoke timestamp for a grant.
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

export async function runAccess(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  try {
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.role = takeFlagValue(rest, ['--role']);
    f.expires = takeFlagValue(rest, ['--expires']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;
  const role = f.role as ProjectRole | undefined;
  const checkRole = (): boolean => {
    if (!role || !ROLES.includes(role)) {
      process.stderr.write(`${status.err(`--role must be one of ${ROLES.join(', ')}`)}\n`);
      return false;
    }
    return true;
  };

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const resp = await ctx.client.get<{ members: AccessMember[]; can_manage: boolean }>(`${base}/access`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        const emailW = Math.max(...resp.members.map((m) => (m.email ?? m.user_id).length), 6);
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}${pad('MEMBER', emailW)}   ACCOUNT   PROJECT ROLE   SOURCE${C.reset}\n`);
        for (const m of resp.members) {
          const eff = m.effective_project_role ?? '—';
          const src = m.effective_source ?? (m.has_implicit_access ? 'implicit' : '—');
          process.stdout.write(
            `  ${pad(m.email ?? m.user_id, emailW)}   ${pad(m.account_role, 7)}   ${pad(eff, 12)}   ${C.faded}${src}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${resp.members.length} member${resp.members.length === 1 ? '' : 's'}${resp.can_manage ? '' : ` ${C.faded}(read-only — you can't manage)${C.reset}`}${C.reset}\n\n`);
        return 0;
      }
      case 'invite': {
        const email = positional[0];
        if (!email) return missing('an email');
        if (!checkRole()) return 2;
        const resp = await ctx.client.post<{ status?: string }>(`${base}/access/invite`, {
          email,
          role,
          ...(f.expires ? { expires_at: f.expires } : {}),
        });
        process.stdout.write(`${status.ok(`Invited ${C.bold}${email}${C.reset} as ${role}${resp.status === 'invited' ? ' (pending signup)' : ''}`)}\n`);
        return 0;
      }
      case 'grant':
      case 'set': {
        const userId = positional[0];
        if (!userId) return missing('a user id');
        if (!checkRole()) return 2;
        await ctx.client.put(`${base}/access/${encodeURIComponent(userId)}`, {
          role,
          ...(f.expires ? { expires_at: f.expires } : {}),
        });
        process.stdout.write(`${status.ok(`${C.bold}${userId}${C.reset} → ${role}`)}\n`);
        return 0;
      }
      case 'revoke': {
        const userId = positional[0];
        if (!userId) return missing('a user id');
        await ctx.client.delete(`${base}/access/${encodeURIComponent(userId)}`);
        process.stdout.write(`${status.ok(`Revoked access for ${C.bold}${userId}${C.reset}`)}\n`);
        return 0;
      }
      case 'pending': {
        const resp = await ctx.client.get<{ pending: PendingInvite[] }>(`${base}/access/pending-invites`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        if (resp.pending.length === 0) {
          process.stdout.write(`  ${C.dim}No pending invites.${C.reset}\n`);
          return 0;
        }
        process.stdout.write('\n');
        for (const p of resp.pending) {
          process.stdout.write(
            `  ${p.email}  ${C.faded}${p.project_role}${C.reset}  ${C.dim}${p.invite_id}${p.invite_expired ? ` ${C.red}(expired)${C.reset}` : ''}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${resp.pending.length} pending${C.reset}\n\n`);
        return 0;
      }
      case 'cancel': {
        const inviteId = positional[0];
        if (!inviteId) return missing('an invite id');
        await ctx.client.delete(`${base}/access/pending-invites/${encodeURIComponent(inviteId)}`);
        process.stdout.write(`${status.ok(`Cancelled invite ${C.bold}${inviteId}${C.reset}`)}\n`);
        return 0;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
