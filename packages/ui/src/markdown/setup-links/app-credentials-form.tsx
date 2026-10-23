'use client';

import { Button } from '../../primitives/button';
import { Field, FieldGroup, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../primitives/input-group';
import Loading from '../../primitives/loading';
import { useTranslations } from '../../i18n';
import {
  getConnectorAppForm,
  HostBoundaryError,
  submitConnectorAppForm,
  type ConnectorAppFormInfo,
} from '@kortix/sdk';
import {
  ArrowUpRightIcon,
  CheckIcon,
  ClockCountdownIcon,
  LinkBreakIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { setupLinkApiBase } from './api-base';
import { StatusNotice } from './secret-intake-form';

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'expired' | 'invalid' | 'stale' | 'error';

const DEV_DASHBOARD_URL = 'https://dev.shopify.com/dashboard';
/** Long enough to read the confirmation before the window closes itself. */
const CLOSE_AFTER_MS = 1_500;

function statusOf(cause: unknown): number | null {
  return cause instanceof HostBoundaryError ? cause.status : null;
}

function DashboardLink({ children }: { children: ReactNode }) {
  return (
    <a
      href={DEV_DASHBOARD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group text-kortix-base focus-visible:ring-ring inline-flex items-baseline gap-0.5 rounded-sm font-medium outline-none focus-visible:ring-2"
    >
      <span className="decoration-kortix-base/40 group-hover:decoration-kortix-base underline underline-offset-2">
        {children}
      </span>
      <ArrowUpRightIcon className="size-3 shrink-0 self-center" />
    </a>
  );
}

/**
 * The form behind an own-app connect link (`/connect/app/[token]`): the app's
 * client credentials and the store, for a Composio toolkit that runs on the
 * customer's own app. Shopify is the one such app today.
 *
 * The page opens in the connect popup. The window that opened it polls the
 * connection, so after a success this window only confirms and closes itself
 * (or follows the native app's return link).
 */
export function AppCredentialsForm({ token }: { token: string }) {
  const t = useTranslations('connectAppForm');
  const base = setupLinkApiBase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<ConnectorAppFormInfo | null>(null);
  const [store, setStore] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConnectorAppForm(token, { backendUrl: base }).then(
      (body) => {
        if (cancelled) return;
        setInfo(body);
        setConnectedAs(body.connected_as);
        setPhase(body.connected ? 'done' : 'ready');
      },
      (cause: unknown) => {
        if (cancelled) return;
        const status = statusOf(cause);
        setMessage(cause instanceof Error ? cause.message : null);
        setPhase(status === 410 ? 'expired' : status === 404 ? 'invalid' : status === 409 ? 'stale' : 'error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [base, token]);

  async function submit() {
    if (!store.trim() || !clientId.trim() || !clientSecret.trim()) {
      setMessage(t.raw('missingFields'));
      return;
    }
    setPhase('submitting');
    setMessage(null);
    try {
      const result = await submitConnectorAppForm(
        token,
        { store: store.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        { backendUrl: base },
      );
      setConnectedAs(result.connected_as);
      setPhase('done');
      window.setTimeout(() => {
        if (result.success_redirect_uri) window.location.assign(result.success_redirect_uri);
        else window.close();
      }, CLOSE_AFTER_MS);
    } catch (cause) {
      const status = statusOf(cause);
      setMessage(cause instanceof Error ? cause.message : t.raw('failed'));
      if (status === 410) setPhase('expired');
      else if (status === 409) setPhase('stale');
      else setPhase('ready');
    }
  }

  const app = info?.name ?? 'Shopify';

  switch (phase) {
    case 'loading':
      return (
        <div
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm"
        >
          <Loading className="size-4 shrink-0" />
          {t.raw('loading')}
        </div>
      );
    case 'expired':
      return (
        <StatusNotice
          icon={ClockCountdownIcon}
          tone="warning"
          title={t.raw('expiredTitle')}
          description={t.raw('startAgain')}
        />
      );
    case 'invalid':
      return (
        <StatusNotice
          icon={LinkBreakIcon}
          tone="destructive"
          title={t.raw('invalidTitle')}
          description={t.raw('startAgain')}
        />
      );
    case 'stale':
      return (
        <StatusNotice
          icon={LinkBreakIcon}
          tone="warning"
          title={t.raw('staleTitle')}
          description={message ?? t.raw('startAgain')}
        />
      );
    case 'error':
      return <StatusNotice icon={WarningCircleIcon} tone="destructive" title={message ?? t.raw('failed')} />;
    case 'done':
      return (
        <StatusNotice
          icon={CheckIcon}
          tone="success"
          title={t('connectedTitle', { app })}
          description={
            connectedAs ? t('connectedDescription', { store: connectedAs }) : t.raw('closeWindow')
          }
        />
      );
  }

  const submitting = phase === 'submitting';

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">{t.raw('stepsTitle')}</p>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs text-pretty">
          <li>{t.rich('step1', { link: (chunks) => <DashboardLink>{chunks}</DashboardLink> })}</li>
          <li>{t.raw('step2')}</li>
          <li>{t.raw('step3')}</li>
          <li>{t.raw('step4')}</li>
        </ol>
        <p className="text-muted-foreground text-xs text-pretty">{t.raw('sameOrganization')}</p>
      </div>

      <FieldGroup className="gap-5">
        <Field className="space-y-2">
          <FieldLabel htmlFor="app-form-store" className="text-foreground">
            {t.raw('storeLabel')}
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="app-form-store"
              name="store"
              autoComplete="off"
              spellCheck={false}
              // 16px below `sm` so iOS Safari does not zoom the page on focus.
              className="font-mono max-sm:text-base"
              placeholder="acme"
              value={store}
              disabled={submitting}
              onChange={(e) => setStore(e.target.value)}
            />
            <InputGroupAddon align="inline-end">.myshopify.com</InputGroupAddon>
          </InputGroup>
        </Field>
        <Field className="space-y-2">
          <FieldLabel htmlFor="app-form-client-id" className="text-foreground">
            {t.raw('clientIdLabel')}
          </FieldLabel>
          <Input
            id="app-form-client-id"
            name="client_id"
            autoComplete="off"
            spellCheck={false}
            className="font-mono max-sm:text-base"
            value={clientId}
            disabled={submitting}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>
        <Field className="space-y-2">
          <FieldLabel htmlFor="app-form-client-secret" className="text-foreground">
            {t.raw('clientSecretLabel')}
          </FieldLabel>
          <Input
            id="app-form-client-secret"
            name="client_secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="font-mono max-sm:text-base"
            placeholder="••••••••••••"
            value={clientSecret}
            disabled={submitting}
            onChange={(e) => setClientSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </Field>
      </FieldGroup>

      <div className="space-y-3">
        {message ? (
          <p role="alert" className="text-destructive text-xs text-pretty">
            {message}
          </p>
        ) : null}
        <Button type="button" className="w-full" onClick={submit} disabled={submitting}>
          {submitting ? <Loading className="size-4 shrink-0" /> : null}
          {submitting ? t.raw('connecting') : t('submit', { app })}
        </Button>
        <p className="text-muted-foreground text-center text-xs text-pretty">{t.raw('secretNote')}</p>
      </div>
    </div>
  );
}
