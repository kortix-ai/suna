import { readFileSync } from 'node:fs';
import { emitJson, fail, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import type { ExtraFlags } from './channels.ts';

// apps/api/src/services/channels/install-store.ts AgentMailSenderPolicy /
// AgentMailInstallSummary; routes at apps/api/src/http/projects/channel-email.ts.

interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

interface EmailInstallation {
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

interface EmailMode {
  provider: 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
}

/** The default connector slug every email route falls back to (channel-email.ts). */
const DEFAULT_EMAIL_CONNECTOR = 'kortix_email';

// ─── Email (AgentMail) ───────────────────────────────────────────────────

/**
 * Build the wire `sender_policy` from repeated `--allow` values.
 *
 * The server's policy has ONE list per kind and no deny list at all
 * (AgentMailSenderPolicy: mode + allowedEmails + allowedDomains +
 * allowedRegex), so a value is routed by shape: `@acme.com` or a bare
 * `acme.com` is a DOMAIN, anything containing a local part is an EMAIL. The
 * server re-derives `mode` — any non-empty list forces `restricted`
 * (normalizeSenderPolicy, apps/api/src/services/channels/install-store.ts:137) — but we
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
          process.stdout.write(
            `${C.dim}email${C.reset}  off — the ${C.cyan}agentmail_email${C.reset} feature flag is disabled for this project.\n` +
              `       Turn it on: ${C.cyan}kortix projects features enable agentmail_email${C.reset}\n`,
          );
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
      case 'connect': {
        if (Boolean(extra.inboxId) !== Boolean(extra.email)) {
          return fail('Attaching an existing inbox needs BOTH --inbox-id and --email.');
        }
        const apiKey = extra.apiKey === '-' ? readFileSync(0, 'utf-8').trim() : extra.apiKey;
        const body: Record<string, unknown> = { connector_slug: slug };
        if (apiKey) body.api_key = apiKey;
        if (extra.displayName) body.display_name = extra.displayName;
        if (extra.username) body.username = extra.username;
        if (extra.domain) body.domain = extra.domain;
        if (extra.inboxId) body.inbox_id = extra.inboxId;
        if (extra.email) body.email = extra.email;
        body.sender_policy = buildSenderPolicy(extra);
        const install = await ctx.client.post<EmailInstallation>(`${base}/connect`, body);
        if (json) {
          emitJson(install);
          return 0;
        }
        printEmailInstall(install);
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
          `${status.ok('Disconnected')} ${C.dim}— connector ${slug}; the AgentMail secrets are removed.${C.reset}\n`,
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
        return fail(`unknown email action "${action}" — status|connect|disconnect|policy`);
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}
