'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Plus } from 'lucide-react';
import { MdShield } from 'react-icons/md';
import { MEMBERS, POLICIES, SECRETS, type Policy } from '../data';
import { BrandLogo, PageHead, Panel, Row } from '../primitives';

function PolicyRow({ policy }: { policy: Policy }) {
  const total = policy.allow + policy.ask + policy.block;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="border-border flex items-center gap-3 border-b px-4 py-3 last:border-0">
      <BrandLogo domain={policy.domain} alt={policy.name} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground text-sm font-medium">{policy.name}</span>
          <span className="text-muted-foreground text-xs">{total} tools</span>
        </div>
        <div className="bg-muted mt-2 flex h-1.5 overflow-hidden rounded-full">
          <span className="bg-kortix-green" style={{ width: pct(policy.allow) }} />
          <span className="bg-amber-500" style={{ width: pct(policy.ask) }} />
          {policy.block > 0 && (
            <span className="bg-destructive" style={{ width: pct(policy.block) }} />
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-xs font-medium">
          <span className="text-emerald-600 dark:text-emerald-500">{policy.allow} allow</span>
          <span className="text-amber-600 dark:text-amber-500">{policy.ask} ask</span>
          <span className={policy.block > 0 ? 'text-destructive' : 'text-muted-foreground/50'}>
            {policy.block} block
          </span>
        </div>
      </div>
    </div>
  );
}

export function SecurityPage() {
  const stats: [string, string][] = [
    [String(MEMBERS.length), 'Members'],
    [String(SECRETS.length), 'Secrets'],
    ['41', 'Tool policies'],
    ['128', 'Audit events · 24h'],
  ];
  return (
    <div>
      <PageHead
        title="Security & access"
        sub="Roles, an encrypted secrets vault and per-tool permissions — with a full audit trail"
      />

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {stats.map(([n, l]) => (
            <div key={l} className="border-border/70 bg-card rounded-md border px-3 py-2.5">
              <div className="text-foreground text-lg font-semibold tracking-tight">{n}</div>
              <div className="text-muted-foreground mt-0.5 text-xs">{l}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Members & roles"
            count="· 3"
            action={
              <Button variant="outline" size="sm">
                <Plus className="size-3.5" /> Invite
              </Button>
            }
          >
            {MEMBERS.map((m) => (
              <Row
                key={m.email}
                leading={<UserAvatar email={m.email} name={m.name} size="sm" />}
                title={m.name}
                subtitle={
                  <InlineMeta>
                    <span>{m.email}</span>
                    <span>{m.last}</span>
                  </InlineMeta>
                }
                trailing={
                  <div className="flex items-center gap-2">
                    <span
                      className="hidden items-center gap-1 text-xs text-emerald-600 sm:flex dark:text-emerald-500"
                      title="Two-factor enabled"
                    >
                      <MdShield className="size-3.5" /> 2FA
                    </span>
                    <Badge size="sm" variant={m.role === 'Owner' ? 'highlight' : 'outline'}>
                      {m.role}
                    </Badge>
                  </div>
                }
              />
            ))}
          </Panel>

          <Panel title="Secrets vault" count="· 5 encrypted">
            {SECRETS.map((sec) => (
              <Row
                key={sec.name}
                leading={<BrandLogo domain={sec.domain} alt={sec.name} size={16} />}
                title={<span className="font-mono text-xs">{sec.name}</span>}
                subtitle={
                  <InlineMeta>
                    <span className="font-mono">{sec.masked}</span>
                    <span>rotated {sec.rotated}</span>
                  </InlineMeta>
                }
                trailing={
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {sec.agents} {sec.agents === 1 ? 'agent' : 'agents'}
                  </span>
                }
              />
            ))}
          </Panel>
        </div>

        <Panel title="Tool permissions" count="· scoped per connector">
          {POLICIES.map((p) => (
            <PolicyRow key={p.name} policy={p} />
          ))}
        </Panel>

        <div className="border-border/60 bg-muted/20 text-muted-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs">
          <MdShield className="size-4 shrink-0" />
          <span>
            SSO + 2FA enforced · secrets injected at sandbox boot, never exposed to agents · every
            tool call logged.
          </span>
        </div>
      </div>
    </div>
  );
}
