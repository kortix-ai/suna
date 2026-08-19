import { clientFromAuth, type ApiClient } from '../api/client.ts';
import {
  emitJson,
  resolveAccountContext,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  OBJECT_GRANT_ROLE,
  expiresLabel,
  fetchRoles,
  iamBase,
  objectLabel,
  parsePrincipalFilter,
  principalLabel,
  principalLabels,
  resolveUserId,
  roleRefBody,
  scopeLabel,
  UUID_RE,
  type IamAssignment,
  type IamRole,
} from '../iam.ts';
import { resolveProjectId } from '../project-link.ts';
import { C, help, pad, status } from '../style.ts';
import type { ProjectSummary } from '../api/types.ts';

// `kortix access` — the CLI face of the ONE grant table.
//
// The canonical surface is `assignments` / `grant --user|--group` / `revoke`,
// over `/accounts/:id/iam/assignments`. Everything a principal can do comes
// from a row there: a role, at a scope (the account, or one project),
// optionally narrowed to one object.
//
// The project read model (`ls`, `invite`, `pending`, `cancel`) and the
// positional `grant <user-id>` / `revoke <user-id>` forms are unchanged. They
// are thin wrappers over `/projects/:id/access`, which the server rebuilt over
// the same assignments — so a script written against them keeps working, byte
// for byte, while the assignment verbs are the documented path.

// Two project roles. `editor` was removed on 2026-08-18 — the API answers
// 400 for it, so the CLI never offers it.
type ProjectRole = 'manager' | 'member';
const ROLES: readonly ProjectRole[] = ['manager', 'member'];

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

const HELP = help`Usage: kortix access <subcommand> [options]

Who can do what. People, groups and service accounts get ROLES — on the
account, on one project, or on a single object inside a project. Agents get
Kortix CLI scopes in kortix.yaml; a session can only do what both allow.

Role assignments:
  assignments [--project <id>|--account|--all]   List role assignments.
  grant --user <id|email>|--group <id>|--service-account <id> --role <key|id>
                                    Grant a role. Prints the assignment id.
  revoke <assignment-id>            Revoke one assignment.

Project members:
  ls [--json]                       List members + effective project roles.
  invite <email> --role <r>         Invite someone to the project.
  grant <user-id> --role <r>        Set a member's project role.
  revoke <user-id>                  Remove a member's project access.
  pending [--json]                  List pending project invitations.
  cancel <invite-id>                Cancel a pending invitation.

Project roles: ${ROLES.join(', ')}. Account roles: owner, admin, member.
Run \`kortix roles ls\` for every role, \`kortix permissions ls\` for the catalog.

Options:
  --user <id|email>  Grant to a person. An email resolves via the account
                     member directory.
  --group <id>       Grant to a group instead of a person.
  --service-account <id>
                     Grant to a service account — an agent's identity.
  --role <key|id>    Role to grant — a system key (owner/admin/member,
                     manager/member) or a custom role's key or id.
  --project <id>     Scope to this project (default: the linked project).
  --account          Scope to the whole account — every project in it.
  --all              List every assignment in the account, at any scope.
  --agent <name>     Narrow the grant to ONE agent. Implies --role ${OBJECT_GRANT_ROLE}.
  --principal <id>   Filter assignments by principal. Also
                     user:<id> | group:<id> | service_account:<id> | pending:<email>.
  --expires <iso>    Auto-revoke timestamp.
  --account-id <id>  Operate on this account (default: the active account).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix access assignments
  kortix access assignments --account
  kortix access grant --user alice@corp.com --role manager
  kortix access grant --user alice@corp.com --role admin --account
  kortix access grant --group 8f3c… --role member --project 1a2b…
  kortix access grant --user alice@corp.com --agent support-bot
  kortix access revoke 4d5e…
`;

interface Scope {
  client: ApiClient;
  accountId: string;
  /** null when the caller asked for account scope or for everything. */
  projectId: string | null;
}

/**
 * Resolve the account (always) and the project (unless `--account`/`--all`).
 *
 * The assignment routes are account-scoped even for a grant that lands on one
 * project, so a `--project` from another account has to move the whole client
 * with it — otherwise the write would be authorized against the wrong account.
 */
async function resolveScope(
  f: Record<string, string | undefined>,
  wantsProject: boolean,
): Promise<Scope | null> {
  const acct = resolveAccountContext({ accountArg: f.accountId, hostArg: f.host });
  if (!acct) return null;
  if (!wantsProject) return { client: acct.client, accountId: acct.accountId, projectId: null };

  const projectId = f.project ?? resolveProjectId();
  if (!projectId) {
    process.stderr.write(
      `${status.err('No project linked.')} Pass ${C.cyan}--project <id>${C.reset} for one project, ` +
        `or ${C.cyan}--account${C.reset} for the whole account.\n`,
    );
    return null;
  }
  const project = await acct.client.get<ProjectSummary>(`/projects/${projectId}`);
  const accountId = project.account_id || acct.accountId;
  const client =
    accountId === acct.accountId ? acct.client : clientFromAuth(acct.auth, { accountId });
  return { client, accountId, projectId };
}

export async function runAccess(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let accountScope = false;
  let allScopes = false;
  try {
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.role = takeFlagValue(rest, ['--role']);
    f.expires = takeFlagValue(rest, ['--expires']);
    f.user = takeFlagValue(rest, ['--user', '--member']);
    f.group = takeFlagValue(rest, ['--group']);
    f.sa = takeFlagValue(rest, ['--service-account', '--sa']);
    f.agent = takeFlagValue(rest, ['--agent']);
    f.principal = takeFlagValue(rest, ['--principal']);
    f.accountId = takeFlagValue(rest, ['--account-id']);
    json = takeFlagBool(rest, ['--json']);
    accountScope = takeFlagBool(rest, ['--account']);
    allScopes = takeFlagBool(rest, ['--all']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  try {
    switch (sub) {
      // ── The canonical surface: role_assignments ──────────────────────────
      case 'assignments':
        return await listAssignments(f, { json, accountScope, allScopes });

      case 'grant':
      case 'set':
        // Flag form = an assignment; positional form = the project read model.
        // Two shapes, never ambiguous, and the old one is untouched.
        if (f.user || f.group || f.sa || f.agent) {
          return await grantAssignment(f, { json, accountScope });
        }
        break;

      case 'revoke':
        if (positional[0]) {
          const handled = await revokeByAssignmentId(positional[0], f, json);
          if (handled !== null) return handled;
        }
        break;

      default:
        break;
    }

    // ── The project read model over /projects/:id/access ─────────────────
    const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
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
        const resp = await ctx.client.post<{
          status?: string;
          /** False when no email left the building — every deployment without
           *  MAILTRAP_API_TOKEN, which is every self-hosted one. */
          email_sent?: boolean;
          email_skip_reason?: string | null;
          /** The only remaining delivery channel when the email was skipped. */
          invite_url?: string;
          message?: string;
        }>(`${base}/access/invite`, {
          email,
          role,
          ...(f.expires ? { expires_at: f.expires } : {}),
        });
        if (json) {
          emitJson(resp);
          return 0;
        }
        const pending = resp.status === 'invited' ? ' (pending signup)' : '';
        // The server tells us whether an email actually went out, and hands back
        // an invite_url precisely so this case is recoverable. Printing a green
        // tick regardless left the inviter waiting for a delivery that never
        // happened — and threw away the only link that would have worked. The
        // web dashboard already warns and offers the link for this same payload,
        // so a CLI user and a web user were told opposite things.
        //
        // `email_sent === undefined` is an older API that predates the field;
        // keep the previous wording rather than inventing a warning.
        if (resp.email_sent === false) {
          process.stdout.write(
            `${status.warn(`Invited ${C.bold}${email}${C.reset} as ${role}${pending} — but NO email was sent${resp.email_skip_reason ? ` (${resp.email_skip_reason})` : ''}.`)}\n`,
          );
          if (resp.invite_url) {
            process.stdout.write(`  Share this link with them:\n  ${C.bold}${resp.invite_url}${C.reset}\n`);
          }
          return 0;
        }
        process.stdout.write(`${status.ok(`Invited ${C.bold}${email}${C.reset} as ${role}${pending}`)}\n`);
        return 0;
      }
      case 'grant':
      case 'set': {
        const userId = positional[0];
        if (!userId) {
          process.stderr.write(
            `${status.err('Pass a user id, or use the assignment form.')}\n` +
              `   ${C.dim}e.g. ${C.cyan}kortix access grant --user alice@corp.com --role manager${C.reset}\n`,
          );
          return 2;
        }
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
        if (!userId) return missing('an assignment id (see `kortix access assignments`) or a user id');
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

// ─── The canonical surface ──────────────────────────────────────────────────

async function listAssignments(
  f: Record<string, string | undefined>,
  opts: { json: boolean; accountScope: boolean; allScopes: boolean },
): Promise<number> {
  const scope = await resolveScope(f, !opts.accountScope && !opts.allScopes);
  if (!scope) return 1;

  const query = new URLSearchParams();
  if (opts.accountScope) query.set('scope_type', 'account');
  if (scope.projectId) {
    query.set('scope_type', 'project');
    query.set('scope_id', scope.projectId);
  }
  if (f.principal) {
    const parsed = parsePrincipalFilter(f.principal);
    if ('error' in parsed) {
      process.stderr.write(`${status.err(parsed.error)}\n`);
      return 2;
    }
    // An email is what `kortix access grant --user` accepts, and it is what a
    // person has in hand right after granting. Resolving it here too — the same
    // `resolveUserId` grant uses — is the difference between `--principal
    // user:someone@example.com` listing their rows and a bare
    // `HTTP 400: principal_id must be a UUID` from the server's shape check.
    let principalId = parsed.id;
    if (parsed.type === 'user' && !UUID_RE.test(principalId)) {
      const resolved = await resolveUserId(scope.client, scope.accountId, principalId);
      if (!resolved) return 1;
      principalId = resolved;
    }
    query.set('principal_type', parsed.type);
    query.set('principal_id', principalId);
  }
  const qs = query.toString();
  const { assignments } = await scope.client.get<{ assignments: IamAssignment[] }>(
    `${iamBase(scope.accountId)}/assignments${qs ? `?${qs}` : ''}`,
  );
  if (opts.json) {
    emitJson({ assignments });
    return 0;
  }
  if (assignments.length === 0) {
    const where = opts.allScopes
      ? 'in this account'
      : opts.accountScope
        ? 'at account scope'
        : 'on this project';
    process.stdout.write(`  ${C.dim}No role assignments ${where}.${C.reset}\n`);
    return 0;
  }
  const labels = await principalLabels(scope.client, scope.accountId);
  const rows = assignments.map((a) => ({
    principal: principalLabel(a, labels),
    role: a.role_key,
    scope: scopeLabel(a),
    object: objectLabel(a),
    expires: expiresLabel(a),
    source: a.source,
    id: a.assignment_id,
  }));
  const w = (key: keyof (typeof rows)[number], header: string) =>
    Math.max(...rows.map((r) => r[key].length), header.length);
  const pw = w('principal', 'PRINCIPAL');
  const rw = w('role', 'ROLE');
  const sw = w('scope', 'SCOPE');
  const ow = w('object', 'OBJECT');
  const ew = w('expires', 'EXPIRES');
  const uw = w('source', 'SOURCE');
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('PRINCIPAL', pw)}   ${pad('ROLE', rw)}   ${pad('SCOPE', sw)}   ${pad('OBJECT', ow)}   ${pad('EXPIRES', ew)}   ${pad('SOURCE', uw)}   ASSIGNMENT${C.reset}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `  ${pad(r.principal, pw)}   ${C.bold}${pad(r.role, rw)}${C.reset}   ${pad(r.scope, sw)}   ${pad(r.object, ow)}   ${pad(r.expires, ew)}   ${C.faded}${pad(r.source, uw)}${C.reset}   ${C.faded}${r.id}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${rows.length} assignment${rows.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function grantAssignment(
  f: Record<string, string | undefined>,
  opts: { json: boolean; accountScope: boolean },
): Promise<number> {
  const chosen = [f.user && '--user', f.group && '--group', f.sa && '--service-account'].filter(
    Boolean,
  ) as string[];
  if (chosen.length > 1) {
    process.stderr.write(
      `${status.err(`Pass one principal — got ${chosen.join(' and ')}.`)}\n`,
    );
    return 2;
  }
  if (f.agent && opts.accountScope) {
    process.stderr.write(
      `${status.err('An object grant is project-scoped — drop --account, or name a project with --project.')}\n`,
    );
    return 2;
  }
  const roleRef = f.role ?? (f.agent ? OBJECT_GRANT_ROLE : undefined);
  if (!roleRef) {
    process.stderr.write(
      `${status.err('Pass --role <key|id>.')} ${C.dim}See ${C.cyan}kortix roles ls${C.reset}${C.dim}.${C.reset}\n`,
    );
    return 2;
  }

  const scope = await resolveScope(f, !opts.accountScope);
  if (!scope) return 1;

  // The catalog is read only to tell a CUSTOM role's id from a SYSTEM role's
  // key — never to refuse an unknown one. See `roleRefBody`.
  const roles = await fetchRoles(scope.client, scope.accountId).catch(() => [] as IamRole[]);

  let principalType: 'user' | 'group' | 'service_account';
  let principalId: string;
  if (f.group) {
    principalType = 'group';
    principalId = f.group;
  } else if (f.sa) {
    // An agent's identity IS a service account, so this is how an agent gets a
    // role. The id comes from `GET /accounts/:id/iam/service-accounts`.
    principalType = 'service_account';
    principalId = f.sa;
  } else {
    principalType = 'user';
    const resolved = await resolveUserId(scope.client, scope.accountId, f.user!);
    if (!resolved) return 1;
    principalId = resolved;
  }

  const assignment = await scope.client.post<IamAssignment>(
    `${iamBase(scope.accountId)}/assignments`,
    {
      principal_type: principalType,
      principal_id: principalId,
      ...roleRefBody(roles, roleRef),
      scope_type: scope.projectId ? 'project' : 'account',
      scope_id: scope.projectId,
      ...(f.agent ? { object_type: 'agent', object_id: f.agent } : {}),
      ...(f.expires ? { expires_at: f.expires } : {}),
    },
  );
  if (opts.json) {
    emitJson(assignment);
    return 0;
  }
  const who = f.group
    ? `group ${f.group}`
    : f.sa
      ? `service account ${f.sa}`
      : (f.user as string);
  const where = scope.projectId ? `project ${scope.projectId}` : 'the account';
  const on = f.agent ? ` on agent ${C.bold}${f.agent}${C.reset}` : '';
  process.stdout.write(
    `${status.ok(`Granted ${C.bold}${assignment.role_key}${C.reset} to ${C.bold}${who}${C.reset} on ${where}${on}`)}\n`,
  );
  process.stdout.write(
    `  ${C.faded}assignment ${assignment.assignment_id} — revoke with ${C.reset}${C.cyan}kortix access revoke ${assignment.assignment_id}${C.reset}\n`,
  );
  return 0;
}

/**
 * Revoke by assignment id.
 *
 * Returns null when the id is NOT an assignment in this account, which is how
 * the historical `kortix access revoke <user-id>` keeps working unchanged: an
 * assignment id and a user id are disjoint id spaces, so the lookup decides
 * without guessing. A caller who cannot read assignments falls through too.
 */
async function revokeByAssignmentId(
  id: string,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number | null> {
  const acct = resolveAccountContext({ accountArg: f.accountId, hostArg: f.host });
  // No credentials at all — it already said so; do not let the legacy path
  // print the same refusal a second time.
  if (!acct) return 1;
  let match: IamAssignment | undefined;
  try {
    const { assignments } = await acct.client.get<{ assignments: IamAssignment[] }>(
      `${iamBase(acct.accountId)}/assignments`,
    );
    match = assignments.find((a) => a.assignment_id === id);
  } catch {
    return null;
  }
  if (!match) return null;

  const resp = await acct.client.delete<{ revoked: boolean; assignment: IamAssignment }>(
    `${iamBase(acct.accountId)}/assignments/${encodeURIComponent(id)}`,
  );
  if (json) {
    emitJson(resp);
    return 0;
  }
  const labels = await principalLabels(acct.client, acct.accountId);
  process.stdout.write(
    `${status.ok(`Revoked ${C.bold}${match.role_key}${C.reset} from ${C.bold}${principalLabel(match, labels)}${C.reset} (${scopeLabel(match)}${match.object_type ? `, ${objectLabel(match)}` : ''})`)}\n`,
  );
  return 0;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}
