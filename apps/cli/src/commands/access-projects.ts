import type { ApiClient } from '../api/client.ts';
import { emitJson, fail, missing } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// `kortix access` — the project read model over `/projects/:id/access`.
//
// The project read model (`ls`, `invite`, `pending`, `cancel`) and the
// positional `grant <user-id>` / `revoke <user-id>` forms are unchanged. They
// are thin wrappers over `/projects/:id/access`, which the server rebuilt over
// the same assignments — so a script written against them keeps working, byte
// for byte, while the assignment verbs are the documented path.

// Two project roles. `editor` was removed on 2026-08-18 — the API answers
// 400 for it, so the CLI never offers it.
export type ProjectRole = 'manager' | 'member';
export const ROLES: readonly ProjectRole[] = ['manager', 'member'];

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

export async function accessLs(client: ApiClient, base: string, json: boolean): Promise<number> {
  const resp = await client.get<{ members: AccessMember[]; can_manage: boolean }>(`${base}/access`);
  if (json) {
    emitJson(resp);
    return 0;
  }
  const emailW = Math.max(...resp.members.map((m) => (m.email ?? m.user_id).length), 6);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('MEMBER', emailW)}   ACCOUNT   PROJECT ROLE   SOURCE${C.reset}\n`,
  );
  for (const m of resp.members) {
    const eff = m.effective_project_role ?? '—';
    const src = m.effective_source ?? (m.has_implicit_access ? 'implicit' : '—');
    process.stdout.write(
      `  ${pad(m.email ?? m.user_id, emailW)}   ${pad(m.account_role, 7)}   ${pad(eff, 12)}   ${C.faded}${src}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.members.length} member${resp.members.length === 1 ? '' : 's'}${resp.can_manage ? '' : ` ${C.faded}(read-only — you can't manage)${C.reset}`}${C.reset}\n\n`,
  );
  return 0;
}

export async function accessInvite(
  client: ApiClient,
  base: string,
  email: string | undefined,
  role: ProjectRole | undefined,
  expires: string | undefined,
  json: boolean,
): Promise<number> {
  if (!email) return missing('an email');
  if (!role || !ROLES.includes(role)) return fail(`--role must be one of ${ROLES.join(', ')}`);
  const resp = await client.post<{
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
    ...(expires ? { expires_at: expires } : {}),
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
      process.stdout.write(
        `  Share this link with them:\n  ${C.bold}${resp.invite_url}${C.reset}\n`,
      );
    }
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Invited ${C.bold}${email}${C.reset} as ${role}${pending}`)}\n`,
  );
  return 0;
}

export async function accessGrantMember(
  client: ApiClient,
  base: string,
  userId: string | undefined,
  role: ProjectRole | undefined,
  expires: string | undefined,
): Promise<number> {
  if (!userId) {
    process.stderr.write(
      `${status.err('Pass a user id, or use the assignment form.')}\n` +
        `   ${C.dim}e.g. ${C.cyan}kortix access grant --user alice@corp.com --role manager${C.reset}\n`,
    );
    return 2;
  }
  if (!role || !ROLES.includes(role)) return fail(`--role must be one of ${ROLES.join(', ')}`);
  await client.put(`${base}/access/${encodeURIComponent(userId)}`, {
    role,
    ...(expires ? { expires_at: expires } : {}),
  });
  process.stdout.write(`${status.ok(`${C.bold}${userId}${C.reset} → ${role}`)}\n`);
  return 0;
}

export async function accessRevoke(
  client: ApiClient,
  base: string,
  userId: string | undefined,
): Promise<number> {
  if (!userId) return missing('an assignment id (see `kortix access assignments`) or a user id');
  await client.delete(`${base}/access/${encodeURIComponent(userId)}`);
  process.stdout.write(`${status.ok(`Revoked access for ${C.bold}${userId}${C.reset}`)}\n`);
  return 0;
}

export async function accessPending(
  client: ApiClient,
  base: string,
  json: boolean,
): Promise<number> {
  const resp = await client.get<{ pending: PendingInvite[] }>(`${base}/access/pending-invites`);
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

export async function accessCancel(
  client: ApiClient,
  base: string,
  inviteId: string | undefined,
): Promise<number> {
  if (!inviteId) return missing('an invite id');
  await client.delete(`${base}/access/pending-invites/${encodeURIComponent(inviteId)}`);
  process.stdout.write(`${status.ok(`Cancelled invite ${C.bold}${inviteId}${C.reset}`)}\n`);
  return 0;
}

export async function accessResend(
  client: ApiClient,
  base: string,
  inviteId: string | undefined,
  json: boolean,
): Promise<number> {
  if (!inviteId) return missing('an invite id (see `kortix access pending`)');
  const resp = await client.post<{
    ok: boolean;
    expires_at: string;
    invite_url: string;
    /** False on every deployment with no email provider configured. */
    email_sent: boolean;
    email_skip_reason: string | null;
  }>(`${base}/access/pending-invites/${encodeURIComponent(inviteId)}/resend`, {});
  if (json) {
    emitJson(resp);
    return 0;
  }
  // Same rule as `invite`: the server says whether an email left the
  // building, and hands back the link precisely so a skipped send is
  // recoverable. Never print a green tick over a delivery that did not
  // happen.
  if (resp.email_sent === false) {
    process.stdout.write(
      `${status.warn(`Invite ${C.bold}${inviteId}${C.reset} refreshed — but NO email was sent${resp.email_skip_reason ? ` (${resp.email_skip_reason})` : ''}.`)}\n`,
    );
  } else {
    process.stdout.write(
      `${status.ok(`Re-sent invite ${C.bold}${inviteId}${C.reset}`)} ${C.dim}(expires ${resp.expires_at})${C.reset}\n`,
    );
  }
  process.stdout.write(`  ${C.bold}${resp.invite_url}${C.reset}\n`);
  return 0;
}
