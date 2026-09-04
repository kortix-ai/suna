/**
 * `kortix sessions share` + `kortix sessions links` — who can see a session,
 * and the unauthenticated links minted off it.
 *
 * Two different mechanisms, deliberately two commands:
 *  - `share`  → PUT /sessions/:id/sharing. Kortix members only. Owner-governed
 *               (the API refuses a manager who cannot read the session).
 *  - `links`  → /sessions/:id/public-shares. A public URL with no login at all,
 *               scoped to ONE preview port or ONE workspace file.
 */

import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { C, help, pad, status } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** The sharing intent the API stores, mirrored back on every session read. */
export type SessionSharing =
  | { mode: 'project' }
  | { mode: 'private'; ownerId: string }
  | { mode: 'members'; memberIds?: string[]; groupIds?: string[] };

type SharedSession = ProjectSession & { sharing?: SessionSharing | null };

interface AccessMember {
  user_id: string;
  email: string | null;
}

/** One row of `/sessions/:id/public-shares`. */
export interface SessionPublicShare {
  share_id: string;
  resource_type: 'preview' | 'file' | string;
  label: string;
  port: number | null;
  path: string;
  file_path: string | null;
  mode: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  public_token?: string;
  public_path?: string;
  proxy_path?: string;
  public_url?: string | null;
}

const SHARE_HELP = help`Usage: kortix sessions share <session-id> [options]

Set who inside Kortix can open this session. With no --mode it prints the
current setting and changes nothing. Owner-governed: the API refuses a project
manager who cannot already read the session.

Modes:
  private            Only the session's owner.
  project            Every member of the project.
  members            Only the named members and groups.

Options:
  --mode <mode>      private | project | members.
  --member <id|email>  Member allowed in members mode (repeatable). An email
                     resolves through the project's member list.
  --group <id>       Account group allowed in members mode (repeatable).
  --show             Print the current setting and exit.
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix sessions share <session-id> --show
  kortix sessions share <session-id> --mode project
  kortix sessions share <session-id> --mode members --member dev@example.com
`;

const LINKS_HELP = help`Usage: kortix sessions links <session-id> <subcommand> [options]

Public, unauthenticated links onto one session — a preview port, or one
workspace file. Minting one needs the session OWNER (a link needs no login, so
it is the owner's call); listing and revoking also accept a project manager.

Subcommands:
  ls                 List every link ever minted, newest first. --json.
  create             Mint one. Preview by default; --file shares a document.
  revoke <share-id>  Kill a link.

Create options:
  --port <n>         Preview port (default 3000). Refused for 22, 8000 and the
                     opencode ports.
  --path <p>         Path inside the preview (default /).
  --preview <id>     Named candidate instead of --port/--path: web | vite |
                     dev-server | api-docs (see \`sessions preview --list\`).
  --file <path>      Share ONE workspace file instead of a preview. Always
                     read-only.
  --mode <mode>      view (default) | interactive. interactive allows writes
                     and websockets; ignored for --file.
  --label <text>     Human label for the link.
  --expires <iso>    Expiry timestamp (ISO 8601).

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix sessions links <session-id> create --port 3000
  kortix sessions links <session-id> create --file out/report.pdf
  kortix sessions links <session-id> ls --json
`;

/** Resolve a `--member` value: a bare id passes through, an email is looked up
 *  in the project's member list (the same list `kortix access ls` prints). */
async function resolveMemberIds(
  client: ApiClient,
  projectId: string,
  values: string[],
): Promise<string[] | null> {
  const emails = values.filter((v) => v.includes('@'));
  if (emails.length === 0) return values;
  let members: AccessMember[];
  try {
    const resp = await client.get<{ members: AccessMember[] }>(`/projects/${projectId}/access`);
    members = resp.members ?? [];
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
  const out: string[] = [];
  for (const value of values) {
    if (!value.includes('@')) {
      out.push(value);
      continue;
    }
    const hit = members.find((m) => m.email?.toLowerCase() === value.toLowerCase());
    if (!hit) {
      process.stderr.write(`${status.err(`No project member with email "${value}".`)}\n`);
      return null;
    }
    out.push(hit.user_id);
  }
  return out;
}

/** Render a sharing intent as one line. */
export function describeSharing(sharing: SessionSharing | null | undefined): string {
  if (!sharing) return 'private (owner only)';
  if (sharing.mode === 'project') return 'project (every project member)';
  if (sharing.mode === 'private') return 'private (owner only)';
  const members = sharing.memberIds ?? [];
  const groups = sharing.groupIds ?? [];
  const parts = [
    `${members.length} member${members.length === 1 ? '' : 's'}`,
    `${groups.length} group${groups.length === 1 ? '' : 's'}`,
  ];
  return `members (${parts.join(', ')})`;
}

export async function runSessionsShare(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SHARE_HELP);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let mode: string | undefined;
  let memberArgs: string[] = [];
  let groupIds: string[] = [];
  let show = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    mode = takeFlagValue(rest, ['--mode']);
    memberArgs = takeFlagValues(rest, ['--member']);
    groupIds = takeFlagValues(rest, ['--group']);
    show = takeFlagBool(rest, ['--show']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${SHARE_HELP}`);
    return 2;
  }
  if (mode && !['private', 'project', 'members'].includes(mode)) {
    process.stderr.write(`${status.err(`--mode must be private, project or members.`)}\n`);
    return 2;
  }
  if (mode === 'members' && memberArgs.length + groupIds.length === 0) {
    // An empty allow-list collapses to project-wide server-side — refuse to
    // silently publish a session the user meant to narrow.
    process.stderr.write(
      `${status.err('--mode members needs at least one --member or --group.')}\n`,
    );
    return 2;
  }

  const opts: CtxOpts = { projectArg, hostArg };
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions share ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  const canonicalSessionId = session.session_id;

  if (show || !mode) {
    const current = (session as SharedSession).sharing ?? null;
    if (json) {
      emitJson({ session_id: canonicalSessionId, sharing: current });
      return 0;
    }
    process.stdout.write(`\n  ${C.dim}session ${C.reset}${canonicalSessionId}\n`);
    process.stdout.write(`  ${C.dim}access  ${C.reset}${describeSharing(current)}\n`);
    if (current && current.mode === 'members') {
      for (const id of current.memberIds ?? []) {
        process.stdout.write(`    ${C.faded}member ${id}${C.reset}\n`);
      }
      for (const id of current.groupIds ?? []) {
        process.stdout.write(`    ${C.faded}group  ${id}${C.reset}\n`);
      }
    }
    process.stdout.write('\n');
    return 0;
  }

  let body: SessionSharing;
  if (mode === 'project') {
    body = { mode: 'project' };
  } else if (mode === 'private') {
    // Empty ownerId: the API resolves the owner from the acting token, the
    // same value the dashboard sends (see share-session-modal).
    body = { mode: 'private', ownerId: '' };
  } else {
    const memberIds = await resolveMemberIds(client, projectId, memberArgs);
    if (!memberIds) return 1;
    body = { mode: 'members', memberIds, groupIds };
  }

  let updated: SharedSession;
  try {
    updated = await client.put<SharedSession>(
      `/projects/${projectId}/sessions/${canonicalSessionId}/sharing`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(updated);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Session access set to ${C.bold}${describeSharing(updated.sharing ?? body)}${C.reset}`)}\n`,
  );
  return 0;
}

export async function runSessionsLinks(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(LINKS_HELP);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let port: string | undefined;
  let path: string | undefined;
  let previewId: string | undefined;
  let filePath: string | undefined;
  let mode: string | undefined;
  let label: string | undefined;
  let expires: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    port = takeFlagValue(rest, ['--port']);
    path = takeFlagValue(rest, ['--path']);
    previewId = takeFlagValue(rest, ['--preview']);
    filePath = takeFlagValue(rest, ['--file']);
    mode = takeFlagValue(rest, ['--mode']);
    label = takeFlagValue(rest, ['--label']);
    expires = takeFlagValue(rest, ['--expires']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  const sessionId = positional[0];
  const sub = positional[1] ?? 'ls';
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${LINKS_HELP}`);
    return 2;
  }
  if (!['ls', 'list', 'create', 'revoke', 'rm'].includes(sub)) {
    process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${LINKS_HELP}`);
    return 2;
  }
  if (mode && !['view', 'interactive'].includes(mode)) {
    process.stderr.write(`${status.err('--mode must be view or interactive.')}\n`);
    return 2;
  }

  const located = await locateSessionAnywhere(
    sessionId,
    { projectArg, hostArg },
    (host) => `kortix sessions links ${sessionId} ${sub} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  const base = `/projects/${projectId}/sessions/${session.session_id}/public-shares`;

  if (sub === 'ls' || sub === 'list') {
    let shares: SessionPublicShare[];
    try {
      shares = (await client.get<{ shares: SessionPublicShare[] }>(base)).shares ?? [];
    } catch (err) {
      return surfaceApiError(err);
    }
    if (json) {
      emitJson(shares);
      return 0;
    }
    if (shares.length === 0) {
      process.stdout.write(
        `  ${C.dim}No public links — mint one with \`kortix sessions links ${sessionId} create\`.${C.reset}\n`,
      );
      return 0;
    }
    const labelW = Math.max(...shares.map((s) => s.label.length), 5);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('LABEL', labelW)}   KIND      MODE          STATE     URL${C.reset}\n`,
    );
    for (const share of shares) {
      const state = share.revoked_at ? 'revoked' : expired(share) ? 'expired' : 'live';
      process.stdout.write(
        `  ${pad(share.label, labelW)}   ${pad(share.resource_type, 8)}  ${pad(share.mode, 12)}  ${pad(state, 8)}  ${C.cyan}${shareUrl(share)}${C.reset}\n`,
      );
      process.stdout.write(`  ${C.faded}${pad('', labelW)}   ${share.share_id}${C.reset}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  if (sub === 'revoke' || sub === 'rm') {
    const shareId = positional[2];
    if (!shareId) {
      process.stderr.write(`${status.err('Pass a share id (see `sessions links <id> ls`).')}\n`);
      return 2;
    }
    let revoked: SessionPublicShare;
    try {
      revoked = (await client.delete<{ share: SessionPublicShare }>(`${base}/${shareId}`)).share;
    } catch (err) {
      return surfaceApiError(err);
    }
    if (json) {
      emitJson(revoked);
      return 0;
    }
    process.stdout.write(`${status.ok(`Revoked ${C.bold}${revoked.label}${C.reset}`)}\n`);
    return 0;
  }

  // create
  const body: Record<string, unknown> = {};
  if (filePath) {
    body.file = { path: filePath, ...(label ? { label } : {}) };
  } else if (previewId) {
    body.preview_id = previewId;
    if (path) body.preview = { path };
  } else {
    const parsedPort = Number(port ?? '3000');
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      process.stderr.write(`${status.err(`Invalid port "${port}".`)}\n`);
      return 2;
    }
    body.preview = { port: parsedPort, path: path ?? '/', ...(label ? { label } : {}) };
  }
  if (mode) body.mode = mode;
  if (label) body.label = label;
  if (expires) body.expires_at = expires;

  let created: SessionPublicShare;
  try {
    created = (await client.post<{ share: SessionPublicShare }>(base, body)).share;
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(created);
    return 0;
  }
  process.stdout.write(`\n${status.ok(`Public link minted ${C.dim}(${created.mode})${C.reset}`)}\n`);
  process.stdout.write(`  ${C.dim}share_id ${C.reset}${created.share_id}\n`);
  process.stdout.write(`  ${C.dim}url      ${C.reset}${C.cyan}${shareUrl(created)}${C.reset}\n`);
  if (created.expires_at) {
    process.stdout.write(`  ${C.dim}expires  ${C.reset}${created.expires_at}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function expired(share: SessionPublicShare): boolean {
  return Boolean(share.expires_at && Date.parse(share.expires_at) < Date.now());
}

/** The absolute preview-origin URL when the deployment serves one, else the
 *  path form the API always returns. */
function shareUrl(share: SessionPublicShare): string {
  return share.public_url || share.proxy_path || share.public_path || '(no url)';
}
