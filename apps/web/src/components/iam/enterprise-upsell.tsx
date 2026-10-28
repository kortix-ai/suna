'use client';

import { useTranslations } from '@/i18n/use-translations';
// Upsell state for the enterprise-gated IAM surfaces (Audit, SAML SSO +
// SCIM). Non-entitled accounts keep the tab/section visible for
// discoverability, but its content is this card: what the feature does, and
// how to get it. An owner or admin turns on the Enterprise demo in one click
// (the features switch on at once, sales is told); anyone may talk to sales in
// one click, without a form. Mirrors the server-side gate: the create/update
// routes 402 without the entitlement (requireEntitlement), so we never render
// controls the backend would reject.
//
// Roles joined them on 2026-10-13 (Jay): an account without the `rbac`
// entitlement sees this card instead of the read-only built-in role list,
// the disabled New role button and an info banner. One gated state, the
// same on every Enterprise pane.
//
// `EnterpriseBadge` is the one plan tag: no lock glyph, a calm blue tint,
// sentence-case sans text (the base `Badge` is mono uppercase).

import { CheckIcon as Check } from '@phosphor-icons/react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { useEnterpriseDemo, useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { APP_REGISTRY_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/app-registry-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { cn } from '@kortix/ui';
import { canManageBilling } from '@kortix/sdk';

type UpsellFeature = 'groups' | 'audit' | 'identity' | 'roles';

const FEATURE_COPY: Record<
  UpsellFeature,
  {
    title: string;
    blurb: string;
    points: [string, string, string];
  }
> = {
  groups: {
    title: 'Groups are an Enterprise feature',
    blurb:
      'Bundle members into groups and grant the whole group a role on a project — one grant instead of dozens, revoked just as easily.',
    points: [
      'Attach a group to any project with a role',
      'Sync membership automatically from your identity provider',
      'Offboard someone everywhere by removing one membership',
    ],
  },
  audit: {
    title: 'Audit logs are an Enterprise feature',
    blurb:
      'A complete, filterable trail of every admin and agent action in the account — who did what, where, and when.',
    points: [
      'Filter by actor, action, resource, and time range',
      'Export as CSV or JSONL for your SIEM',
      'Stream events out via audit webhooks',
    ],
  },
  identity: {
    title: 'SAML SSO & SCIM are Enterprise features',
    blurb:
      'Bring your identity provider — Okta, Microsoft Entra ID, or any SAML IdP — and let it drive who gets in and what they can touch.',
    points: [
      'Single sign-on with just-in-time member provisioning',
      'IdP groups map to roles on your projects',
      'SCIM keeps users and groups in sync, including offboarding',
    ],
  },
  roles: {
    title: 'Custom roles are an Enterprise feature',
    blurb:
      'Define roles of your own — pick exactly what a member may view and change — and hand them out from Members and Projects like the built-in ones.',
    points: [
      'Start from a built-in role and remove what you do not need',
      'Assign a custom role on the account or on one project',
      'See every capability a role grants before you assign it',
    ],
  },
};

/** The plan tag for an Enterprise-only surface. No lock: the word is the signal. */
export function EnterpriseBadge({ className }: { className?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Badge variant="info" size="sm" className={cn('font-sans tracking-normal', className)}>
      {tI18nComplete.raw('text3fbe5ed156f1')}
    </Badge>
  );
}

interface EnterpriseUpsellProps {
  feature: UpsellFeature;
  accountId: string;
}

export function EnterpriseUpsell({ feature, accountId }: EnterpriseUpsellProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('billing.access');
  const copy = localizeUiCatalog(FEATURE_COPY, tI18nComplete, APP_REGISTRY_TRANSLATION_KEYS)[
    feature
  ];
  // Turning on the demo needs `billing.write` (owners and admins).
  const manager = canManageBilling(useAccountState({ accountId }).data);
  const demo = useEnterpriseDemo(accountId);
  const sales = useTalkToSales(accountId);

  return (
    <section className="bg-popover rounded-md border">
      <div className="space-y-3 px-4 py-4">
        <div className="space-y-1.5">
          <EnterpriseBadge />
          <h3 className="text-foreground text-sm font-medium">{copy.title}</h3>
        </div>
        <p className="text-muted-foreground max-w-xl text-sm">{copy.blurb}</p>
        <ul className="space-y-1.5">
          {copy.points.map((point) => (
            <li key={point} className="text-muted-foreground flex items-start gap-2 text-xs">
              <Check className="text-kortix-green mt-0.5 size-3.5 shrink-0" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">
          {manager ? t('upsellDemoHint') : t('upsellAskManager')}
        </p>
        <span className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={sales.isPending} onClick={sales.talk}>
            {t('talkToSales')}
          </Button>
          {manager ? (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={demo.isPending}
              onClick={() => demo.set(true)}
            >
              {demo.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('demoTurnOnEnterprise')}
            </Button>
          ) : null}
        </span>
      </div>
    </section>
  );
}
