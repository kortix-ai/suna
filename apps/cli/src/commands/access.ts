import { type ApiClient, clientFromAuth } from '../api/client.ts';
import type { ProjectSummary } from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveAccountContext,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  type IamAssignment,
  type IamRole,
  OBJECT_GRANT_ROLE,
  UUID_RE,
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
} from '../iam.ts';
import { resolveProjectId } from '../project-link.ts';
import { C, help, pad, status } from '../style.ts';
import {
  type ProjectRole,
  ROLES,
  accessCancel,
  accessGrantMember,
  accessInvite,
  accessLs,
  accessPending,
  accessResend,
  accessRevoke,
} from './access-projects.ts';

// `kortix access` — the CLI face of the ONE grant table.
//
// The canonical surface is `assignments` / `grant --user|--group` / `revoke`,
// over `/accounts/:id/iam/assignments`. Everything a principal can do comes
// from a row there: a role, at a scope (the account, or one project),
// optionally narrowed to one object. The project read model over
// `/projects/:id/access` lives in access-projects.ts.

const HELP = help`Usage: kortix access <subcommand> [options]

Who can do what. People, groups and service accounts get ROLES — on the
account, on one project, or on a single object inside a project. Agents get
Kortix permissions in kortix.yaml; a session can only do what both allow.

Role assignments:
  assignments [--project <id>|--account|--all]   List role assignments.
  grant --user <id|email>|--group <id>|--service-account <id> --role <key|id>
                                    Grant a role. Prints the assignment id.
  grant --user|--group|--everyone --agent <name>|--connection <id>
                                    Grant one agent, or the use of one shared
                                    connector account.
  revoke <assignment-id>            Revoke one assignment.

Project members:
  ls [--json]                       List members + effective project roles.
  invite <email> --role <r>         Invite someone to the project.
  grant <user-id> --role <r>        Set a member's project role.
  revoke <user-id>                  Remove a member's project access.
  pending [--json]                  List pending project invitations.
  resend <invite-id>                Re-send an invite email + refresh its
                                    14-day expiry. Prints the link too.
  cancel <invite-id>                Cancel a pending invitation.

Access requests (people asking to join this project):
  requests ls [--json]              List pending access requests.
  requests approve <req-id>         Approve one — grants the project role.
           [--role <r>]             Default: member.
  requests reject <req-id>          Reject one.

Every verb in these two blocks needs project.members.manage.

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
  --connection <id>  Narrow the grant to ONE shared connector account. The first
                     grant limits the account to its grantees; revoking the last
                     opens it to the whole project again. Implies --role ${OBJECT_GRANT_ROLE}.
  --everyone         Grant to everyone with access to the project. Holds an
                     agent or a connection, never a role.
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
  kortix access grant --everyone --agent support-bot
  kortix access grant --group 8f3c… --connection 2b7e…
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
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
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
    f.connection = takeFlagValue(rest, ['--connection']);
    f.everyone = takeFlagBool(rest, ['--everyone']) ? 'yes' : undefined;
    f.principal = takeFlagValue(rest, ['--principal']);
    f.accountId = takeFlagValue(rest, ['--account-id']);
    json = takeFlagBool(rest, ['--json']);
    accountScope = takeFlagBool(rest, ['--account']);
    allScopes = takeFlagBool(rest, ['--all']);
  } catch (err) {
    return fail((err as Error).message);
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
        if (f.user || f.group || f.sa || f.agent || f.connection || f.everyone) {
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
    // (the handlers are thin wrappers — they live in access-projects.ts)
    const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
    if (!ctx) return 1;
    const base = `/projects/${ctx.projectId}`;
    const role = f.role as ProjectRole | undefined;

    switch (sub) {
      case 'ls':
      case 'list':
        return accessLs(ctx.client, base, json);
      case 'invite':
        return accessInvite(ctx.client, base, positional[0], role, f.expires, json);
      case 'grant':
      case 'set':
        return accessGrantMember(ctx.client, base, positional[0], role, f.expires);
      case 'revoke':
        return accessRevoke(ctx.client, base, positional[0]);
      case 'pending':
        return accessPending(ctx.client, base, json);
      case 'cancel':
        return accessCancel(ctx.client, base, positional[0]);
      case 'resend':
        return accessResend(ctx.client, base, positional[0], json);
      case 'requests':
      case 'access-requests':
        return await accessRequests(ctx, positional, role, json);
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ─── Access requests ────────────────────────────────────────────────────────
//
// Someone who can SEE a project they are not on asks to join; a manager
// approves (granting a project role in the same step) or rejects. Distinct from
// `invite`, which starts from the manager's side.

interface ProjectAccessRequest {
  request_id: string;
  requester_user_id: string;
  requester_email: string | null;
  message: string | null;
  status: string;
  created_at: string;
}

async function accessRequests(
  ctx: { client: ApiClient; projectId: string },
  positional: string[],
  role: ProjectRole | undefined,
  json: boolean,
): Promise<number> {
  const base = `/projects/${ctx.projectId}/access-requests`;
  const action = positional[0] ?? 'ls';

  if (action === 'ls' || action === 'list') {
    const { requests } = await ctx.client.get<{ requests: ProjectAccessRequest[] }>(base);
    if (json) {
      emitJson({ requests });
      return 0;
    }
    if (requests.length === 0) {
      process.stdout.write(`  ${C.dim}No pending access requests.${C.reset}\n`);
      return 0;
    }
    const whoW = Math.max(
      ...requests.map((r) => (r.requester_email ?? r.requester_user_id).length),
      9,
    );
    process.stdout.write('\n');
    process.stdout.write(`  ${C.dim}${pad('REQUESTER', whoW)}   REQUEST ID${C.reset}\n`);
    for (const r of requests) {
      process.stdout.write(
        `  ${pad(r.requester_email ?? r.requester_user_id, whoW)}   ${C.faded}${r.request_id}${C.reset}\n`,
      );
      if (r.message) process.stdout.write(`    ${C.dim}${r.message}${C.reset}\n`);
    }
    process.stdout.write(
      `\n  ${C.dim}${requests.length} request${requests.length === 1 ? '' : 's'}${C.reset}\n\n`,
    );
    return 0;
  }

  const requestId = positional[1];
  if (action === 'approve') {
    if (!requestId) return missing('a request id (see `kortix access requests ls`)');
    if (role && !ROLES.includes(role)) {
      return fail(`--role must be one of ${ROLES.join(', ')}`);
    }
    // The server defaults an omitted role to `member`; send it only when asked
    // so the default lives in one place.
    const resp = await ctx.client.post<{
      request: ProjectAccessRequest;
      member: { email: string | null; effective_project_role: string | null };
    }>(`${base}/${encodeURIComponent(requestId)}/approve`, role ? { role } : {});
    if (json) {
      emitJson(resp);
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Approved ${C.bold}${resp.member.email ?? resp.request.requester_user_id}${C.reset} → ${resp.member.effective_project_role ?? 'member'}`)}\n`,
    );
    return 0;
  }
  if (action === 'reject' || action === 'deny') {
    if (!requestId) return missing('a request id (see `kortix access requests ls`)');
    const resp = await ctx.client.post<{ request: ProjectAccessRequest }>(
      `${base}/${encodeURIComponent(requestId)}/reject`,
      {},
    );
    if (json) {
      emitJson(resp);
      return 0;
    }
    process.stdout.write(`${status.ok(`Rejected request ${C.bold}${requestId}${C.reset}`)}\n`);
    return 0;
  }
  return fail(`unknown requests action "${action}" — use ls, approve, or reject`);
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
      return fail(parsed.error);
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
  const chosen = [
    f.user && '--user',
    f.group && '--group',
    f.sa && '--service-account',
    f.everyone && '--everyone',
  ].filter(Boolean) as string[];
  if (chosen.length > 1) {
    return fail(`Pass one principal — got ${chosen.join(' and ')}.`);
  }
  if (f.agent && f.connection) {
    return fail('Pass one object — got --agent and --connection.');
  }
  const object = f.agent
    ? { type: 'agent', id: f.agent }
    : f.connection
      ? { type: 'connection', id: f.connection }
      : null;
  if (object && opts.accountScope) {
    return fail(
      'An object grant is project-scoped — drop --account, or name a project with --project.',
    );
  }
  if (f.everyone && (!object || f.role)) {
    process.stderr.write(
      `${status.err('--everyone holds an agent or a connection, never a role.')} ` +
        `Add --agent <name> or --connection <id>.\n`,
    );
    return 2;
  }
  const roleRef = f.role ?? (object ? OBJECT_GRANT_ROLE : undefined);
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

  let principalType: 'user' | 'group' | 'service_account' | 'project';
  let principalId: string;
  if (f.everyone) {
    // Everyone with access to the project: the principal id is the project.
    if (!scope.projectId) {
      return fail('--everyone needs a project: link one or pass --project.');
    }
    principalType = 'project';
    principalId = scope.projectId;
  } else if (f.group) {
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
      ...(object ? { object_type: object.type, object_id: object.id } : {}),
      ...(f.expires ? { expires_at: f.expires } : {}),
    },
  );
  if (opts.json) {
    emitJson(assignment);
    return 0;
  }
  const who = f.everyone
    ? 'everyone in project'
    : f.group
      ? `group ${f.group}`
      : f.sa
        ? `service account ${f.sa}`
        : (f.user as string);
  const where = scope.projectId ? `project ${scope.projectId}` : 'the account';
  const on = object ? ` on ${object.type} ${C.bold}${object.id}${C.reset}` : '';
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
