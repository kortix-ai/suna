import { readFileSync } from 'node:fs';
import { emitJson, fail, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import type { ExtraFlags } from './channels.ts';

// The email install the API returns (Resend Inboxes); routes at
// apps/api/src/projects/routes/channel-email.ts.

interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

export interface EmailInstallation {
  connectionSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
  /** Only on GET/POST, not on PATCH. */
  connection_id?: string | null;
}

export interface EmailMode {
  /** `'agentmail'`: a server from before the Resend switch. */
  provider: 'resend' | 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
  managed_domain?: string;
}

/** One inbox: an account of the email connector (GET/POST …/channels/email/inboxes). */
export interface EmailInbox {
  connection_id: string;
  inbox_id: string;
  email: string;
  display_name: string | null;
  label: string;
  owner_type: 'member' | 'project';
  owner_id: string | null;
  is_default: boolean;
  managed: boolean;
  created_by_kortix: boolean;
  sender_policy: { mode: 'allow_all' | 'restricted'; allowed_emails: string[]; allowed_domains: string[]; allowed_regex: string | null };
  agent_name: string | null;
  created_at: string;
}

function inboxPolicy(i: EmailInbox): EmailSenderPolicy {
  return {
    mode: i.sender_policy.mode,
    allowedEmails: i.sender_policy.allowed_emails,
    allowedDomains: i.sender_policy.allowed_domains,
    allowedRegex: i.sender_policy.allowed_regex,
  };
}

function printInbox(i: EmailInbox): void {
  const who = i.owner_type === 'member' ? 'only you' : 'project';
  process.stdout.write(
    `  ${C.bold}${i.email}${C.reset}${i.is_default ? `  ${C.green}default${C.reset}` : ''}
` +
      `      ${C.dim}${who} · ${i.managed ? 'Kortix managed' : 'your Resend account'} · senders: ${describePolicy(inboxPolicy(i))}` +
      `${i.agent_name ? ` · agent ${i.agent_name}` : ''} · ${i.connection_id}${C.reset}
`,
  );
}

interface EmailDomain {
  domain_id: string | null;
  domain: string;
  status: string;
  verified: boolean;
  records: Array<{ type: string; name: string; value: string; status: string; priority?: number }>;
  reason?: string;
}

interface EmailDomainResult {
  domain: EmailDomain;
  setup: { url: string; provider_name: string | null } | null;
}

/** A domain and, until it verifies, the DNS records to set. */
function printDomain(d: EmailDomain): void {
  const state = d.verified ? `${C.green}verified${C.reset}` : `${C.yellow}${d.status.toLowerCase()}${C.reset}`;
  process.stdout.write(`  ${C.bold}${d.domain}${C.reset}  ${state}${d.domain_id ? `  ${C.dim}${d.domain_id}${C.reset}` : ''}\n`);
  if (d.verified) return;
  if (d.reason) process.stdout.write(`    ${C.dim}${d.reason}${C.reset}\n`);
  for (const r of d.records) {
    const ok = r.status === 'VALID' ? C.green + '✓' : C.yellow + '·';
    process.stdout.write(
      `    ${ok}${C.reset} ${r.type.padEnd(5)} ${r.name}  ${C.dim}${r.priority !== undefined ? `${r.priority} ` : ''}${r.value}${C.reset}\n`,
    );
  }
}

/** The default connector slug every email route falls back to (channel-email.ts). */
const DEFAULT_EMAIL_CONNECTOR = 'kortix_email';

/** The project flag the email channel sits behind (experimental, off by default). */
const EMAIL_FLAG = 'email_channel';

function emailOffLine(flag: string): string {
  return `off for this project — the ${flag} feature flag is off. Turn it on: kortix projects features enable ${flag}`;
}

const OWN_KEY_NEEDED =
  'Pass --api-key <re_…>: a full-access key from https://resend.com/api-keys, on a Resend account with a ' +
  'receiving domain (https://resend.com/docs/dashboard/receiving/custom-domains).';

// ─── Email (Resend) ───────────────────────────────────────────────────

/**
 * Build the wire `sender_policy` from repeated `--allow` values.
 *
 * The server's policy has ONE list per kind and no deny list at all
 * (the sender policy: mode + allowedEmails + allowedDomains +
 * allowedRegex), so a value is routed by shape: `@acme.com` or a bare
 * `acme.com` is a DOMAIN, anything containing a local part is an EMAIL. The
 * server re-derives `mode` — any non-empty list forces `restricted`
 * (normalizeSenderPolicy, apps/api/src/channels/install-store.ts:137) — but we
 * send it explicitly so the intent is visible on the wire.
 */
function buildSenderPolicy(extra: ExtraFlags): EmailSenderPolicy {
  const allowedEmails: string[] = [];
  const allowedDomains: string[] = [];
  for (const raw of extra.allow) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (value.startsWith('@')) allowedDomains.push(value.replace(/^@+/, ''));
    else if (value.includes('@')) allowedEmails.push(value);
    else allowedDomains.push(value);
  }
  const regex = extra.allowRegex?.trim() || null;
  const restricted = allowedEmails.length > 0 || allowedDomains.length > 0 || Boolean(regex);
  return {
    mode: restricted ? 'restricted' : 'allow_all',
    allowedEmails,
    allowedDomains,
    allowedRegex: regex,
  };
}

function printEmailInstall(install: EmailInstallation): void {
  const p = install.senderPolicy;
  process.stdout.write(
    `${status.ok('email')}  ${C.bold}${install.email}${C.reset}\n` +
      `         connector  ${C.dim}${install.connectionSlug}${C.reset}\n` +
      `         inbox      ${C.dim}${install.inboxId}${C.reset}\n` +
      `         from-name  ${C.dim}${install.displayName ?? '—'}${C.reset}\n` +
      `         senders    ${C.dim}${describePolicy(p)}${C.reset}\n`,
  );
}

function describePolicy(p: EmailSenderPolicy | undefined): string {
  if (!p || p.mode !== 'restricted') return 'anyone';
  const parts: string[] = [];
  if (p.allowedEmails.length > 0) parts.push(p.allowedEmails.join(', '));
  if (p.allowedDomains.length > 0) parts.push(p.allowedDomains.map((d) => `@${d}`).join(', '));
  if (p.allowedRegex) parts.push(`/${p.allowedRegex}/`);
  return `restricted — ${parts.join(' · ') || 'nothing'}`;
}

export async function emailCommand(
  ctxOpts: { projectArg?: string; hostArg?: string },
  rest: string[],
  extra: ExtraFlags,
  json: boolean,
): Promise<number> {
  const action = rest.find((a) => !a.startsWith('-')) ?? 'status';
  const slug = extra.connector ?? DEFAULT_EMAIL_CONNECTOR;
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}/channels/email`;
  const q = `?connector_slug=${encodeURIComponent(slug)}`;

  try {
    switch (action) {
      case 'status':
      case 'show':
      case 'ls': {
        const [mode, install] = await Promise.all([
          ctx.client.get<EmailMode>(`${base}/mode`),
          ctx.client.get<EmailInstallation | null>(`${base}/installation${q}`),
        ]);
        if (json) {
          emitJson({ connected: Boolean(install), mode, installation: install ?? null });
          return 0;
        }
        if (!mode.enabled) {
          // An older (AgentMail) server gated email behind `agentmail_email`.
          const flag = mode.provider === 'agentmail' ? 'agentmail_email' : EMAIL_FLAG;
          process.stdout.write(`${C.dim}email${C.reset}  ${emailOffLine(flag)}\n`);
          return 0;
        }
        if (!install) {
          process.stdout.write(
            `${C.dim}email${C.reset}  not connected ${C.dim}(connector ${slug}${mode.managed_available ? '' : ', managed key NOT configured on this host'})${C.reset}\n` +
              `       Run ${C.cyan}kortix channels email connect${C.reset}.\n`,
          );
          return 0;
        }
        printEmailInstall(install);
        return 0;
      }
      case 'inboxes':
      case 'inbox': {
        const [sub, arg] = rest.filter((a) => !a.startsWith('-')).slice(1);
        const list = async () => (await ctx.client.get<{ inboxes: EmailInbox[] }>(`${base}/inboxes`)).inboxes;
        const pick = async (ref: string | undefined): Promise<EmailInbox | null> => {
          if (!ref) return null;
          const wanted = ref.trim().toLowerCase();
          return (
            (await list()).find(
              (i) => i.connection_id === ref || i.email.toLowerCase() === wanted || i.label.toLowerCase() === wanted,
            ) ?? null
          );
        };
        if (!sub || sub === 'ls' || sub === 'list') {
          const inboxes = await list();
          if (json) {
            emitJson({ inboxes });
            return 0;
          }
          if (inboxes.length === 0) {
            process.stdout.write(`${C.dim}No inboxes yet.${C.reset} Add one: ${C.cyan}kortix channels email inboxes add --username <name>${C.reset}\n`);
            return 0;
          }
          for (const i of inboxes) printInbox(i);
          return 0;
        }
        if (sub === 'add') {
          if (extra.share && extra.share !== 'me' && extra.share !== 'project') {
            return fail('--share must be "me" or "project".');
          }
          const apiKey = extra.apiKey === '-' ? readFileSync(0, 'utf-8').trim() : extra.apiKey;
          if (!apiKey) {
            const mode = await ctx.client.get<EmailMode>(`${base}/mode`).catch(() => null);
            if (!mode?.managed_available) return fail(OWN_KEY_NEEDED);
          }
          const body: Record<string, unknown> = { share: extra.share ?? 'project', sender_policy: buildSenderPolicy(extra) };
          if (apiKey) body.api_key = apiKey;
          if (extra.username) body.username = extra.username;
          if (extra.domain) body.domain = extra.domain;
          if (extra.displayName) body.display_name = extra.displayName;
          if (extra.label) body.label = extra.label;
          if (extra.inboxId) body.inbox_id = extra.inboxId;
          if (extra.agent) body.agent_name = extra.agent;
          let inbox: EmailInbox;
          try {
            inbox = await ctx.client.post<EmailInbox>(`${base}/inboxes`, body);
          } catch (err) {
            if ((err as { body?: { code?: unknown } }).body?.code === 'email_key_required') {
              return fail(`Kortix-managed email is not offered on this deployment. ${OWN_KEY_NEEDED}`);
            }
            throw err;
          }
          if (json) {
            emitJson(inbox);
            return 0;
          }
          process.stdout.write(`${status.ok('Inbox added')}\n`);
          printInbox(inbox);
          return 0;
        }
        if (sub === 'rm' || sub === 'remove' || sub === 'policy' || sub === 'default') {
          if (!arg) return fail(`Usage: kortix channels email inboxes ${sub} <address|connection_id>`);
          const inbox = await pick(arg);
          if (!inbox) return fail(`No inbox "${arg}" — see kortix channels email inboxes`);
          if (sub === 'rm' || sub === 'remove') {
            const result = await ctx.client.delete<{ status: string; inbox_deleted: boolean }>(
              `${base}/inboxes/${encodeURIComponent(inbox.connection_id)}`,
            );
            if (json) {
              emitJson({ ...result, connection_id: inbox.connection_id, email: inbox.email });
              return 0;
            }
            process.stdout.write(
              `${status.ok(`Removed ${inbox.email}`)} ${C.dim}— ${result?.inbox_deleted ? 'deleted on Resend' : 'unlinked; the Resend inbox stays'}${C.reset}\n`,
            );
            return 0;
          }
          if (sub === 'default') {
            await ctx.client.put(`/projects/${ctx.projectId}/connections/${encodeURIComponent(inbox.connection_id)}/default`, {});
            if (json) {
              emitJson({ ok: true, connection_id: inbox.connection_id });
              return 0;
            }
            process.stdout.write(`${status.ok(`${inbox.email} is the default inbox`)}\n`);
            return 0;
          }
          if (!extra.allowAll && extra.allow.length === 0 && !extra.allowRegex) {
            return fail('Pass at least one --allow <email|@domain>, --allow-regex <re>, or --allow-all.');
          }
          const policy = extra.allowAll
            ? { mode: 'allow_all' as const, allowedEmails: [], allowedDomains: [], allowedRegex: null }
            : buildSenderPolicy(extra);
          const updated = await ctx.client.patch<EmailInbox>(`${base}/inboxes/${encodeURIComponent(inbox.connection_id)}`, {
            sender_policy: policy,
          });
          if (json) {
            emitJson(updated);
            return 0;
          }
          process.stdout.write(`${status.ok(`Sender policy updated — ${describePolicy(inboxPolicy(updated))}`)}\n`);
          return 0;
        }
        return fail(`unknown inboxes action "${sub}" — ls|add|rm|policy|default`);
      }
      case 'connect': {
        if (Boolean(extra.inboxId) !== Boolean(extra.email)) {
          return fail('Attaching an existing inbox needs BOTH --inbox-id and --email.');
        }
        const apiKey = extra.apiKey === '-' ? readFileSync(0, 'utf-8').trim() : extra.apiKey;
        // Your own Resend key comes first. Without one, only a server that
        // offers managed inboxes (RESEND_MANAGED_EMAIL_ENABLED) can create one.
        if (!apiKey) {
          const mode = await ctx.client.get<EmailMode>(`${base}/mode`).catch(() => null);
          if (!mode?.managed_available) return fail(OWN_KEY_NEEDED);
        }
        const body: Record<string, unknown> = { connector_slug: slug };
        if (apiKey) body.api_key = apiKey;
        if (extra.displayName) body.display_name = extra.displayName;
        if (extra.username) body.username = extra.username;
        if (extra.domain) body.domain = extra.domain;
        if (extra.inboxId) body.inbox_id = extra.inboxId;
        if (extra.email) body.email = extra.email;
        body.sender_policy = buildSenderPolicy(extra);
        let install: EmailInstallation;
        try {
          install = await ctx.client.post<EmailInstallation>(`${base}/connect`, body);
        } catch (err) {
          // Managed inboxes are off on this deployment: say what works instead.
          if ((err as { body?: { code?: unknown } }).body?.code === 'email_key_required') {
            return fail(`Kortix-managed email is not offered on this deployment. ${OWN_KEY_NEEDED}`);
          }
          throw err;
        }
        if (json) {
          emitJson(install);
          return 0;
        }
        printEmailInstall(install);
        return 0;
      }
      case 'domains': {
        // `domains` · `domains add <domain>` · `domains verify <domain_id>`. The
        // key goes in the POST body; `--api-key -` reads it from stdin.
        const apiKey = extra.apiKey === '-' ? readFileSync(0, 'utf-8').trim() : extra.apiKey;
        const [sub, arg] = rest.filter((a) => !a.startsWith('-')).slice(1);
        if (sub === 'add' || sub === 'verify') {
          if (!arg) return fail(sub === 'add' ? 'Usage: kortix channels email domains add <domain> --api-key <key>' : 'Usage: kortix channels email domains verify <domain_id> --api-key <key>');
          const result = await ctx.client.post<EmailDomainResult>(
            `${base}/domains/${sub}`,
            sub === 'add' ? { api_key: apiKey, domain: arg } : { api_key: apiKey, domain_id: arg },
          );
          if (json) {
            emitJson(result);
            return 0;
          }
          printDomain(result.domain);
          if (result.setup) {
            process.stdout.write(
              `\n  Set the records in one click${result.setup.provider_name ? ` at ${result.setup.provider_name}` : ''}: ${C.cyan}${result.setup.url}${C.reset}\n`,
            );
          }
          if (!result.domain.verified) {
            process.stdout.write(
              `\n  Add the records at your DNS provider, then: ${C.cyan}kortix channels email domains verify ${result.domain.domain_id} --api-key …${C.reset}\n`,
            );
          }
          return 0;
        }
        if (sub) return fail(`unknown domains action "${sub}" — add|verify`);
        const list = await ctx.client.post<{ managed: boolean; default_domain: string; domains: EmailDomain[] }>(
          `${base}/domains`,
          apiKey ? { api_key: apiKey } : {},
        );
        if (json) {
          emitJson(list);
          return 0;
        }
        process.stdout.write(
          `${list.managed ? 'Managed account' : 'Your Resend account'} — inboxes can use:\n`,
        );
        for (const d of list.domains) printDomain(d);
        if (list.managed) {
          process.stdout.write(`\n  ${C.dim}Custom domains need your own key: --api-key <key>${C.reset}\n`);
        }
        return 0;
      }
      case 'disconnect':
      case 'rm':
      case 'remove': {
        await ctx.client.delete(`${base}/installation${q}`);
        if (json) {
          emitJson({ status: 'disconnected', connector_slug: slug });
          return 0;
        }
        process.stdout.write(
          `${status.ok('Disconnected')} ${C.dim}— connector ${slug}; the inbox secrets are removed.${C.reset}\n`,
        );
        return 0;
      }
      case 'policy': {
        if (!extra.allowAll && extra.allow.length === 0 && !extra.allowRegex) {
          return fail(
            'Pass at least one --allow <email|@domain>, --allow-regex <re>, or --allow-all.',
          );
        }
        // The PATCH REPLACES the whole policy — --allow-all is the explicit way
        // to ask for the empty (accept-everyone) one, so it never happens by
        // accident from a typo'd --allow.
        const sender_policy = extra.allowAll
          ? {
              mode: 'allow_all' as const,
              allowedEmails: [],
              allowedDomains: [],
              allowedRegex: null,
            }
          : buildSenderPolicy(extra);
        const install = await ctx.client.patch<EmailInstallation>(`${base}/installation`, {
          connector_slug: slug,
          sender_policy,
        });
        if (json) {
          emitJson(install);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`Sender policy updated — ${describePolicy(install.senderPolicy)}`)}\n`,
        );
        return 0;
      }
      default:
        return fail(`unknown email action "${action}" — inboxes|status|connect|domains|disconnect|policy`);
    }
  } catch (err) {
    // The project's `email_channel` flag is off: name the one command that turns it on.
    if ((err as { body?: { feature?: unknown } }).body?.feature === EMAIL_FLAG) {
      process.stderr.write(`${status.err(`Email is ${emailOffLine(EMAIL_FLAG)}`)}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }
}
