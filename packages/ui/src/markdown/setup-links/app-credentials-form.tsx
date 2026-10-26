'use client';

import { CopyRow } from '../../access/access/copy-row';
import { Button } from '../../primitives/button';
import { Field, FieldGroup, FieldLabel } from '../../primitives/field';
import { InfoBanner } from '../../primitives/info-banner';
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
import { ShopifyAccessList } from './shopify-access';

// Machine values, not prose: Shopify serves every store at <handle>.myshopify.com.
const SHOPIFY_HOST_SUFFIX = '.myshopify.com';
const EXAMPLE_STORE_HANDLE = 'acme';

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'expired' | 'invalid' | 'stale' | 'error';

const DEV_DASHBOARD_URL = 'https://dev.shopify.com/dashboard';
/** Long enough to read the confirmation before the window closes itself. */
const CLOSE_AFTER_MS = 1_500;

/** `?error=<code>`: the Shopify callback sent the browser back with a failure. */
const CALLBACK_ERROR = {
  invalid_signature: 'errorInvalidSignature',
  shop_mismatch: 'errorShopMismatch',
  token_exchange_failed: 'errorTokenExchange',
  app_missing: 'errorAppMissing',
  authorization_failed: 'errorAuthorizationFailed',
  authorization_strategy_changed: 'errorStrategyChanged',
} as const;

type CallbackErrorKey = (typeof CALLBACK_ERROR)[keyof typeof CALLBACK_ERROR] | 'errorUnknown';

function callbackErrorKey(search: string): CallbackErrorKey | null {
  const code = new URLSearchParams(search).get('error');
  if (!code) return null;
  return Object.hasOwn(CALLBACK_ERROR, code)
    ? CALLBACK_ERROR[code as keyof typeof CALLBACK_ERROR]
    : 'errorUnknown';
}

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
 * The form behind an own-app connect link (`/connect/app/[token]`). Two flows:
 *
 * - `oauth` (the native Shopify connector): the store, and the Client ID and
 *   secret of the merchant's own app unless the deployment has a shared app.
 *   Submit answers Shopify's authorize URL; this window goes there. Shopify's
 *   callback sends it back here with `?connected=1` or `?error=<code>`.
 * - `client_credentials` (a Composio toolkit on the customer's own app, the
 *   default for older servers): the store and the app's credentials connect at
 *   once.
 *
 * The page opens in the connect popup. The window that opened it polls the
 * connection and closes the popup, so after a success this window only
 * confirms (a Composio connect also closes itself or follows the native app's
 * return link).
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
  const [callbackError, setCallbackError] = useState<CallbackErrorKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConnectorAppForm(token, { backendUrl: base }).then(
      (body) => {
        if (cancelled) return;
        setInfo(body);
        setConnectedAs(body.connected_as);
        if (body.flow === 'oauth') {
          setStore((body.shop ?? '').replace(SHOPIFY_HOST_SUFFIX, ''));
          setCallbackError(callbackErrorKey(window.location.search));
        }
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

  // Back from Shopify's consent page restores this page from the back-forward
  // cache, still `submitting`: give the form back.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPhase((current) => (current === 'submitting' ? 'ready' : current));
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const oauth = info?.flow === 'oauth';
  const sharedApp = oauth && info?.shared_app === true;

  async function submit() {
    if (!store.trim() || (!sharedApp && (!clientId.trim() || !clientSecret.trim()))) {
      setMessage(t.raw(sharedApp ? 'missingStore' : 'missingFields'));
      return;
    }
    setPhase('submitting');
    setMessage(null);
    setCallbackError(null);
    try {
      const result = await submitConnectorAppForm(
        token,
        sharedApp
          ? { store: store.trim() }
          : { store: store.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        { backendUrl: base },
      );
      if (result.authorize_url) {
        // Shopify's consent page. The phase stays `submitting` while it loads.
        window.location.assign(result.authorize_url);
        return;
      }
      setConnectedAs(result.connected_as ?? null);
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
        <div className="space-y-5">
          <StatusNotice
            icon={CheckIcon}
            tone="success"
            title={t('connectedTitle', { app })}
            description={
              connectedAs ? t('connectedDescription', { store: connectedAs }) : t.raw('closeWindow')
            }
          />
          {oauth && info?.access ? <ShopifyAccessList access={info.access} /> : null}
        </div>
      );
  }

  const submitting = phase === 'submitting';

  return (
    <div className="space-y-5">
      {callbackError ? (
        <InfoBanner
          role="alert"
          tone="destructive"
          icon={WarningCircleIcon}
          title={t('callbackErrorTitle', { app })}
        >
          {t.raw(callbackError)}
        </InfoBanner>
      ) : null}

      {sharedApp ? (
        <p className="text-muted-foreground text-xs text-pretty">{t.raw('sharedAppNote')}</p>
      ) : oauth ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">{t.raw('stepsTitle')}</p>
            <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-xs text-pretty">
              <li>{t.rich('step1', { link: (chunks) => <DashboardLink>{chunks}</DashboardLink> })}</li>
              {/* The Dev Dashboard order: configure and release a version, then distribute it. */}
              <li>{t.raw('oauthStep3')}</li>
              <li>{t.raw('oauthStep2')}</li>
              <li>{t.raw('step3')}</li>
              <li>{t.raw('step4')}</li>
            </ol>
            <p className="text-muted-foreground text-xs text-pretty">{t.raw('protectedDataNote')}</p>
          </div>
          {info?.redirect_uri ? (
            <CopyRow label={t.raw('redirectUrlLabel')} value={info.redirect_uri} />
          ) : null}
          {info?.scopes?.length ? (
            <CopyRow label={t.raw('scopesLabel')} value={info.scopes.join(',')} />
          ) : null}
        </div>
      ) : (
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
      )}

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
              placeholder={EXAMPLE_STORE_HANDLE}
              value={store}
              disabled={submitting}
              onChange={(e) => setStore(e.target.value)}
              onKeyDown={(e) => {
                if (sharedApp && e.key === 'Enter') void submit();
              }}
            />
            <InputGroupAddon align="inline-end">{SHOPIFY_HOST_SUFFIX}</InputGroupAddon>
          </InputGroup>
        </Field>
        {sharedApp ? null : (
          <>
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
          </>
        )}
      </FieldGroup>

      <div className="space-y-3">
        {message ? (
          <p role="alert" className="text-destructive text-xs text-pretty">
            {message}
          </p>
        ) : null}
        <Button
          type="button"
          className="w-full"
          onClick={submit}
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? <Loading className="size-4 shrink-0" /> : null}
          {oauth
            ? submitting
              ? t('openingApp', { app })
              : t('continueToApp', { app })
            : submitting
              ? t.raw('connecting')
              : t('submit', { app })}
        </Button>
        {sharedApp ? null : (
          <p className="text-muted-foreground text-center text-xs text-pretty">
            {t.raw(oauth ? 'oauthSecretNote' : 'secretNote')}
          </p>
        )}
      </div>
    </div>
  );
}
