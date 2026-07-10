'use client';

// Upsell state for the enterprise-gated IAM surfaces (Groups, Roles, Audit,
// SAML SSO + SCIM). Non-entitled accounts keep the tab/section visible for
// discoverability, but its content is this card: what the feature does, and a
// "Request a demo" CTA to the enterprise page. Mirrors the server-side gate —
// the create/update routes 402 without the entitlement (requireEntitlement),
// so we never render controls the backend would reject.

import { ArrowUpRight, Check, FileClock, KeyRound, Lock, ShieldCheck, Users } from 'lucide-react';
import type { ComponentType } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export const ENTERPRISE_PAGE_URL = 'https://kortix.com/enterprise';

type UpsellFeature = 'groups' | 'roles' | 'audit' | 'identity';

const FEATURE_COPY: Record<
  UpsellFeature,
  {
    icon: ComponentType<{ className?: string }>;
    title: string;
    blurb: string;
    points: [string, string, string];
  }
> = {
  groups: {
    icon: Users,
    title: 'Groups are an Enterprise feature',
    blurb:
      'Bundle members into groups and grant the whole group a role on a project — one grant instead of dozens, revoked just as easily.',
    points: [
      'Attach a group to any project with a role',
      'Sync membership automatically from your identity provider',
      'Offboard someone everywhere by removing one membership',
    ],
  },
  roles: {
    icon: KeyRound,
    title: 'Custom roles are an Enterprise feature',
    blurb:
      'Go beyond the built-in presets: compose roles from fine-grained capabilities and assign them exactly where they apply.',
    points: [
      'Pick per-capability permissions (files, secrets, triggers, …)',
      'Duplicate a built-in preset and subtract what you don’t want',
      'Assign roles to users or groups per project',
    ],
  },
  audit: {
    icon: FileClock,
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
    icon: ShieldCheck,
    title: 'SAML SSO & SCIM are Enterprise features',
    blurb:
      'Bring your identity provider — Okta, Microsoft Entra ID, or any SAML IdP — and let it drive who gets in and what they can touch.',
    points: [
      'Single sign-on with just-in-time member provisioning',
      'IdP groups map to roles on your projects',
      'SCIM keeps users and groups in sync, including offboarding',
    ],
  },
};

interface EnterpriseUpsellProps {
  feature: UpsellFeature;
}

export function EnterpriseUpsell({ feature }: EnterpriseUpsellProps) {
  const copy = FEATURE_COPY[feature];
  const Icon = copy.icon;

  return (
    <section className="border-border/70 bg-card rounded-md border">
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <div className="bg-muted/60 relative flex size-12 items-center justify-center rounded-full">
          <Icon className="text-muted-foreground size-5" />
          <span className="bg-background border-border/70 absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border">
            <Lock className="text-muted-foreground size-3" />
          </span>
        </div>

        <Badge variant="kortix" size="sm" className="mt-4">
          Enterprise
        </Badge>

        <h3 className="text-foreground mt-3 text-base font-semibold">{copy.title}</h3>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">{copy.blurb}</p>

        <ul className="mt-5 space-y-2 text-left">
          {copy.points.map((point) => (
            <li key={point} className="text-muted-foreground flex items-start gap-2 text-sm">
              <Check className="text-kortix-green mt-0.5 size-4 shrink-0" />
              <span>{point}</span>
            </li>
          ))}
        </ul>

        <Button asChild size="sm" className="mt-6 gap-1.5">
          <a href={ENTERPRISE_PAGE_URL} target="_blank" rel="noreferrer">
            Request a demo
            <ArrowUpRight className="size-3.5 shrink-0" />
          </a>
        </Button>
        <p className="text-muted-foreground mt-2 text-xs">
          Talk to us about the Enterprise plan — SSO, SCIM, RBAC, audit, SLA, and DPA.
        </p>
      </div>
    </section>
  );
}
