'use client';

/**
 * Connect Email: give the agent an inbox. Two homes for it:
 *   - Kortix managed: the deployment's AgentMail account, on its managed
 *     domain (`mode.managed_domain`, `agentmail.to` unless configured).
 *   - Your AgentMail account: your key, on `agentmail.to` or any domain you
 *     verified there. A new domain is added here and shows the DNS records
 *     to set, with one-click setup when the DNS provider supports it.
 * Then who may email the agent: a new inbox starts sessions on this
 * project's credits, so the preselected choice is the viewer alone, or their
 * work domain. "Anyone" stays one click away.
 */
import { CheckIcon, CopyIcon, EnvelopeSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from '../../../i18n';
import {
  type EmailDomain,
  type EmailDomainResult,
  type EmailSenderPolicy,
  useAddEmailDomain,
  useConnectEmail,
  useEmailMode,
  useListEmailDomains,
  useVerifyEmailDomain,
} from '../../../internal/hooks/channels/use-channels-installations';
import { useCopy } from '../../../internal/hooks/use-copy';
import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Field, FieldDescription, FieldLabel } from '../../../primitives/field';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import Loading from '../../../primitives/loading';
import { RadioGroup, RadioGroupItem } from '../../../primitives/radio-group';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../../../primitives/select';
import { Textarea } from '../../../primitives/textarea';
import { UiLink as Link, useUiViewer } from '../../../providers/ui-provider';

const AGENTMAIL_DOMAIN = 'agentmail.to';
const ADD_DOMAIN = '__add__';

// ponytail: a short list of public mail providers, so "people at gmail.com" is
// never offered as a team. A provider not listed only changes the preselection.
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.de', 'gmx.net', 'web.de',
]);

type Home = 'managed' | 'own';
export type Senders = 'me' | 'team' | 'anyone' | 'custom';

function splitList(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean)));
}

/** The viewer's work domain, or null for a public mail provider or no email. */
export function teamDomainOf(email: string | null | undefined): string | null {
  const domain = email?.trim().toLowerCase().split('@')[1] || null;
  return domain && !PUBLIC_MAIL_DOMAINS.has(domain) ? domain : null;
}

/** The choice preselected for a new inbox: the narrowest one that still names a real sender. */
export function defaultSenders(email: string | null | undefined): Senders {
  return teamDomainOf(email) ? 'team' : email ? 'me' : 'anyone';
}

/** The wire policy for a choice. `custom` routes each entry by shape: with a local part an email, else a domain. */
export function senderPolicyFor(
  choice: Senders,
  input: { email: string | null; customList: string },
): EmailSenderPolicy {
  const none = { allowedEmails: [], allowedDomains: [], allowedRegex: null };
  const team = teamDomainOf(input.email);
  if (choice === 'anyone') return { mode: 'allow_all', ...none };
  if (choice === 'team' && team) return { mode: 'restricted', ...none, allowedDomains: [team] };
  // `me`, or a `team` choice with no work domain: never wider than the viewer.
  if (choice !== 'custom') {
    return { mode: 'restricted', ...none, allowedEmails: input.email ? [input.email.toLowerCase()] : [] };
  }
  const items = splitList(input.customList);
  return {
    mode: 'restricted',
    allowedRegex: null,
    allowedEmails: items.filter((v) => v.includes('@') && !v.startsWith('@')),
    allowedDomains: items.filter((v) => !v.includes('@') || v.startsWith('@')).map((v) => v.replace(/^@+/, '')),
  };
}

function defaultUsername(connectorSlug: string): string {
  return connectorSlug.replace(/^email_/, '').replace(/_[a-z0-9]{4}$/i, '').replace(/_/g, '-').replace(/^kortix-email$/, 'agent');
}

export function EmailConnectForm({
  projectId,
  connectorSlug,
  onConnected,
}: {
  projectId: string;
  connectorSlug: string;
  onConnected: () => void;
}) {
  const t = useTranslations('emailConnect');
  const mode = useEmailMode(projectId);
  const connect = useConnectEmail();
  const listDomains = useListEmailDomains();
  const viewerEmail = useUiViewer()?.email?.trim().toLowerCase() || null;
  const teamDomain = teamDomainOf(viewerEmail);

  const managedAvailable = mode.data?.managed_available === true;
  const managedDomain = mode.data?.managed_domain || AGENTMAIL_DOMAIN;
  const [homeChoice, setHome] = useState<Home | null>(null);
  // Until the user picks, the home follows what the deployment offers.
  const home: Home = homeChoice ?? (managedAvailable ? 'managed' : 'own');

  const [apiKey, setApiKey] = useState('');
  const [domain, setDomain] = useState(AGENTMAIL_DOMAIN);
  const [added, setAdded] = useState<EmailDomain[]>([]);
  const [username, setUsername] = useState(() => defaultUsername(connectorSlug));
  const [displayName, setDisplayName] = useState('Kortix Agent');
  const [senders, setSenders] = useState<Senders>(() => defaultSenders(viewerEmail));
  const [customList, setCustomList] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [inboxId, setInboxId] = useState('');
  const [inboxEmail, setInboxEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A pasted key loads that account's domains, half a second after typing stops.
  const key = apiKey.trim();
  useEffect(() => {
    if (home !== 'own' || key.length < 8) return;
    const timer = setTimeout(() => listDomains.mutate({ projectId, apiKey: key }), 500);
    return () => clearTimeout(timer);
    // `listDomains.mutate` is stable; re-running on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, key, projectId]);

  const ownDomains = useMemo(() => {
    const listed = home === 'own' && key ? (listDomains.data?.domains ?? []) : [];
    const byName = new Map<string, EmailDomain>();
    for (const d of [...listed, ...added]) byName.set(d.domain, d);
    if (!byName.has(AGENTMAIL_DOMAIN)) {
      byName.set(AGENTMAIL_DOMAIN, { domain_id: null, domain: AGENTMAIL_DOMAIN, status: 'VERIFIED', verified: true, records: [] });
    }
    return [...byName.values()];
  }, [added, home, key, listDomains.data]);

  const selected = home === 'own' ? ownDomains.find((d) => d.domain === domain) : undefined;
  const addressDomain = home === 'managed' ? managedDomain : domain === ADD_DOMAIN ? '…' : domain;
  const address = `${username || 'agent'}@${addressDomain}`;
  const domainReady = home === 'managed' || (domain !== ADD_DOMAIN && selected?.verified !== false);

  const submit = () => {
    setError(null);
    if (home === 'own' && !key) return setError(t('errorKeyRequired'));
    if (attachOpen && (!inboxId.trim() || !inboxEmail.trim())) return setError(t('errorAttachBoth'));
    const policy = senderPolicyFor(senders, { email: viewerEmail, customList });
    if (senders === 'custom' && policy.allowedEmails.length + policy.allowedDomains.length === 0) {
      return setError(t('errorCustomEmpty'));
    }
    connect.mutate(
      {
        projectId,
        connector_slug: connectorSlug,
        ...(home === 'own' ? { api_key: key } : {}),
        display_name: displayName.trim() || undefined,
        ...(attachOpen
          ? { inbox_id: inboxId.trim(), email: inboxEmail.trim() }
          : {
              username: username.trim() || undefined,
              ...(home === 'own' && domain !== AGENTMAIL_DOMAIN ? { domain } : {}),
            }),
        sender_policy: policy,
      },
      { onSuccess: onConnected, onError: (e) => setError((e as Error).message) },
    );
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-foreground text-sm font-medium">{t('homeTitle')}</h3>
        <RadioGroup value={home} onValueChange={(v) => setHome(v as Home)} className="grid gap-2 sm:grid-cols-2">
          <RadioGroupItem
            value="managed"
            variant="outline"
            disabled={!managedAvailable}
            label={t('homeManaged')}
            description={managedAvailable ? t('homeManagedHint', { domain: managedDomain }) : t('homeManagedOff')}
          />
          <RadioGroupItem value="own" variant="outline" label={t('homeOwn')} description={t('homeOwnHint')} />
        </RadioGroup>
        {home === 'own' ? (
          <Field>
            <FieldLabel htmlFor="email-connect-key">{t('keyLabel')}</FieldLabel>
            <Input
              id="email-connect-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="am_…"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>
              {listDomains.isPending ? t('keyChecking') : listDomains.isError ? (
                <span className="text-destructive">{(listDomains.error as Error).message}</span>
              ) : listDomains.data && key ? (
                t('keyOk', { count: listDomains.data.domains.length })
              ) : (
                t('keyHint')
              )}
            </FieldDescription>
          </Field>
        ) : null}
      </section>

      {!attachOpen ? (
        <section className="space-y-3">
          <h3 className="text-foreground text-sm font-medium">{t('addressTitle')}</h3>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t('usernameLabel')}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
              placeholder="support"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
            />
            <span className="text-muted-foreground text-sm">@</span>
            {home === 'managed' ? (
              <span className="bg-muted text-foreground flex h-9 min-w-0 flex-1 items-center rounded-md px-3 text-sm">
                <span className="truncate">{managedDomain}</span>
              </span>
            ) : (
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger aria-label={t('domainLabel')} className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownDomains.map((d) => (
                    <SelectItem key={d.domain} value={d.domain}>
                      <span className="flex items-center gap-2">
                        {d.domain}
                        {d.verified ? null : <Badge variant="secondary">{t('domainPending')}</Badge>}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={ADD_DOMAIN} disabled={!key}>
                    {t('domainAdd')}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <EnvelopeSimpleIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {displayName.trim() || 'Kortix Agent'} &lt;{address}&gt;
            </span>
          </p>
          {home === 'own' && domain === ADD_DOMAIN ? (
            <AddDomain
              projectId={projectId}
              apiKey={key}
              onAdded={(result) => {
                setAdded((list) => [...list.filter((d) => d.domain !== result.domain.domain), result.domain]);
                setDomain(result.domain.domain);
              }}
            />
          ) : null}
          {home === 'own' && selected && !selected.verified ? (
            <DomainRecords
              projectId={projectId}
              apiKey={key}
              domain={selected}
              onChecked={(result) =>
                setAdded((list) => [...list.filter((d) => d.domain !== result.domain.domain), result.domain])
              }
            />
          ) : null}
          <Field>
            <FieldLabel htmlFor="email-connect-name">{t('displayNameLabel')}</FieldLabel>
            <Input
              id="email-connect-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Kortix Agent"
            />
          </Field>
        </section>
      ) : null}

      <section className="space-y-3">
        <div>
          <h3 className="text-foreground text-sm font-medium">{t('sendersTitle')}</h3>
          <p className="text-muted-foreground mt-1 text-xs">{t('sendersHint')}</p>
        </div>
        <RadioGroup value={senders} onValueChange={(v) => setSenders(v as Senders)}>
          {viewerEmail ? <RadioGroupItem value="me" label={t('sendersMe', { email: viewerEmail })} /> : null}
          {teamDomain ? <RadioGroupItem value="team" label={t('sendersTeam', { domain: teamDomain })} /> : null}
          <RadioGroupItem value="custom" label={t('sendersCustom')} />
          <RadioGroupItem value="anyone" label={t('sendersAnyone')} description={t('sendersAnyoneHint')} />
        </RadioGroup>
        {senders === 'custom' ? (
          <Textarea
            aria-label={t('sendersCustom')}
            value={customList}
            onChange={(e) => setCustomList(e.target.value)}
            placeholder={t('sendersCustomPlaceholder')}
            rows={3}
            spellCheck={false}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <Button type="button" variant="text" size="sm" className="px-0" onClick={() => setAttachOpen((open) => !open)}>
          {attachOpen ? t('attachClose') : t('attachOpen')}
        </Button>
        {attachOpen ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="email-connect-inbox-email">{t('attachEmail')}</FieldLabel>
              <Input
                id="email-connect-inbox-email"
                value={inboxEmail}
                onChange={(e) => setInboxEmail(e.target.value.trim().toLowerCase())}
                placeholder="support@example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-connect-inbox-id">{t('attachId')}</FieldLabel>
              <Input
                id="email-connect-inbox-id"
                value={inboxId}
                onChange={(e) => setInboxId(e.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <p className="text-muted-foreground text-xs sm:col-span-2">{t('attachHint')}</p>
          </div>
        ) : null}
      </section>

      {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={connect.isPending || mode.isLoading || (!attachOpen && !domainReady)}>
          {connect.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {attachOpen ? t('submitAttach') : t('submitCreate', { address })}
        </Button>
      </div>
    </div>
  );
}

/** Add a custom domain to the account of `apiKey`. */
function AddDomain({
  projectId,
  apiKey,
  onAdded,
}: {
  projectId: string;
  apiKey: string;
  onAdded: (result: EmailDomainResult) => void;
}) {
  const t = useTranslations('emailConnect');
  const add = useAddEmailDomain();
  const [value, setValue] = useState('');
  return (
    <div className="bg-muted/40 space-y-2 rounded-md border p-3">
      <div className="flex gap-2">
        <Input
          aria-label={t('domainAddLabel')}
          value={value}
          onChange={(e) => setValue(e.target.value.trim().toLowerCase())}
          placeholder="mail.example.com"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
        />
        <Button
          variant="secondary"
          disabled={!value || add.isPending}
          onClick={() => add.mutate({ projectId, apiKey, domain: value }, { onSuccess: onAdded })}
        >
          {add.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('domainAddSubmit')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {add.isError ? <span className="text-destructive">{(add.error as Error).message}</span> : t('domainAddHint')}
      </p>
    </div>
  );
}

/** The DNS records an unverified domain still needs, with one-click setup and "Check again". */
function DomainRecords({
  projectId,
  apiKey,
  domain,
  onChecked,
}: {
  projectId: string;
  apiKey: string;
  domain: EmailDomain;
  onChecked: (result: EmailDomainResult) => void;
}) {
  const t = useTranslations('emailConnect');
  const verify = useVerifyEmailDomain();
  const setup = verify.data?.domain.domain === domain.domain ? verify.data.setup : null;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">{t('recordsTitle', { domain: domain.domain })}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{domain.reason || t('recordsHint')}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={!domain.domain_id || verify.isPending}
          onClick={() =>
            domain.domain_id &&
            verify.mutate({ projectId, apiKey, domainId: domain.domain_id }, { onSuccess: onChecked })
          }
        >
          {verify.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('recordsCheck')}
        </Button>
      </div>
      {setup ? (
        <Button size="sm" asChild>
          <Link href={setup.url} target="_blank" rel="noopener noreferrer">
            {setup.provider_name ? t('recordsOneClickAt', { provider: setup.provider_name }) : t('recordsOneClick')}
          </Link>
        </Button>
      ) : null}
      <ul className="divide-y rounded-md border">
        {domain.records.map((record) => (
          <RecordRow key={`${record.type}:${record.name}:${record.value}`} record={record} />
        ))}
      </ul>
      {verify.isError ? <p className="text-destructive text-xs">{(verify.error as Error).message}</p> : null}
    </div>
  );
}

function RecordRow({ record }: { record: EmailDomain['records'][number] }) {
  const t = useTranslations('emailConnect');
  const { copied, copy } = useCopy({ toast: false });
  const valid = record.status === 'VALID';
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2 text-xs">
      <span className="text-muted-foreground font-mono">{record.type}</span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground truncate font-mono">{record.name}</p>
        <p className="text-muted-foreground font-mono break-all">
          {record.priority !== undefined ? `${record.priority} ` : ''}
          {record.value}
        </p>
        {record.reason ? <p className="text-destructive">{record.reason}</p> : null}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          {valid ? <CheckIcon aria-hidden className="text-kortix-green size-3.5" /> : null}
          {valid ? t('recordValid') : t('recordMissing')}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label={t('recordCopy')} onClick={() => void copy(record.value)}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
    </li>
  );
}
