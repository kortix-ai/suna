'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  AtSign,
  BookOpen,
  Boxes,
  Brain,
  ChevronDown,
  ChevronsUpDown,
  GitPullRequest,
  MessageSquare,
  Paperclip,
  Plug,
  Plus,
  Sparkles,
  Terminal,
} from 'lucide-react';

/**
 * A still of the Kortix command center — the real product surface: projects that
 * are repos, sessions in sandboxes, and change requests waiting on a human.
 * Static by design, and token-driven so it holds in both themes.
 */

const NAV = [
  { name: 'Projects', icon: Boxes, active: true },
  { name: 'Sessions', icon: MessageSquare },
  { name: 'Change requests', icon: GitPullRequest, badge: '3' },
  { name: 'Agents', icon: Sparkles },
  { name: 'Skills', icon: BookOpen },
  { name: 'Connectors', icon: Plug },
  { name: 'Memory', icon: Brain },
];

const SESSIONS = [
  {
    title: 'Draft the renewal for Acme',
    agent: 'go-to-market',
    branch: 'session/renewal-acme',
    state: 'running' as const,
  },
  {
    title: 'Triage 42 new support threads',
    agent: 'support-triage',
    branch: 'session/triage-inbox',
    state: 'running' as const,
  },
  {
    title: 'Reconcile the Stripe payouts for July',
    agent: 'finance-ops',
    branch: 'session/payouts-jul',
    state: 'review' as const,
  },
];

const CHANGE_REQUESTS = [
  { title: 'sales/renewals/acme.md', meta: 'go-to-market · 2 files · needs 1 approval' },
  { title: 'memory/accounts/northstar.md', meta: 'support-triage · 1 file · needs 1 approval' },
];

const STATE_STYLE = {
  running: { label: 'Running', dot: 'bg-kortix-blue', text: 'text-kortix-blue' },
  review: { label: 'Needs review', dot: 'bg-kortix-orange', text: 'text-kortix-orange' },
  merged: { label: 'Merged', dot: 'bg-kortix-green', text: 'text-kortix-green' },
};

export function AppPreview() {
  return (
    <div className="bg-background flex h-full w-full min-w-[64rem] text-left">
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="border-border bg-sidebar flex w-[15rem] shrink-0 flex-col border-r p-3">
        <div className="mb-4 flex items-center gap-2 px-1.5">
          <span className="bg-foreground flex size-5 items-center justify-center rounded-sm">
            <KortixLogo size={11} variant="symbol" className="text-background" />
          </span>
          <span className="text-foreground text-[13px] font-medium">Acme Inc</span>
          <ChevronsUpDown className="text-muted-foreground size-3" />
          <span className="border-border bg-background ml-auto flex size-6 items-center justify-center rounded-sm border">
            <Plus className="text-muted-foreground size-3.5" />
          </span>
        </div>

        <div className="space-y-0.5">
          {NAV.map((item) => (
            <div
              key={item.name}
              className={cn(
                'flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px]',
                item.active ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              <item.icon className="size-3.5 shrink-0" />
              <span className="truncate">{item.name}</span>
              {item.badge && (
                <span className="bg-kortix-orange/15 text-kortix-orange ml-auto rounded-full px-1.5 text-[10px] font-medium">
                  {item.badge}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="text-muted-foreground mt-6 mb-2 px-2.5 text-xs">Projects</div>
        <div className="space-y-1 px-2.5">
          {['acme-ops', 'growth', 'platform'].map((p, i) => (
            <div key={p} className="flex items-center gap-2">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  i === 0 ? 'bg-kortix-green' : 'bg-muted-foreground/30',
                )}
              />
              <span
                className={cn(
                  'font-mono text-[12px]',
                  i === 0 ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {p}
              </span>
            </div>
          ))}
        </div>

        <div className="border-border text-muted-foreground mt-auto flex items-center gap-2 border-t pt-3 font-mono text-[11px]">
          <Terminal className="size-3" />
          kortix ship
        </div>
      </aside>

      {/* ── main ────────────────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-border flex items-center gap-2 border-b px-6 py-3.5">
          <span className="text-foreground text-[13px] font-medium">acme-ops</span>
          <span className="bg-kortix-green/15 text-kortix-green rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
            live
          </span>
          <span className="text-muted-foreground font-mono text-[11px]">
            git.kortix.com/acme/acme-ops · main
          </span>
        </div>

        <div className="border-border bg-muted/30 border-b px-6 py-9">
          <div className="border-border bg-background mx-auto max-w-2xl rounded-sm border p-4 shadow-xs">
            <p className="text-foreground text-[13px]">
              Draft the Q3 renewal for Acme and post it to #company-ops
              <span className="bg-foreground ml-px inline-block h-3.5 w-px translate-y-0.5" />
            </p>
            <div className="text-muted-foreground mt-5 flex items-center gap-3 text-[12px]">
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                go-to-market <ChevronsUpDown className="size-3" />
              </span>
              <span className="flex items-center gap-1.5">
                <Icon.Claude className="size-3.5" />
                Opus 5 <ChevronsUpDown className="size-3" />
              </span>
              <span className="ml-auto flex items-center gap-3">
                <AtSign className="size-3.5" />
                <Paperclip className="size-3.5" />
                <span className="bg-foreground text-background flex h-6 items-center gap-1.5 rounded-full px-2.5">
                  <ArrowRight className="size-3" />
                  <span className="bg-background/30 h-3 w-px" />
                  <ChevronDown className="size-3" />
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-[1.35fr_1fr]">
          <div className="border-border space-y-3 border-r px-6 pt-6">
            <div className="flex items-baseline gap-2">
              <h3 className="text-foreground text-[15px] font-medium">Active sessions</h3>
              <span className="text-muted-foreground text-xs">3</span>
            </div>
            <div className="space-y-2">
              {SESSIONS.map((session) => {
                const s = STATE_STYLE[session.state];
                return (
                  <div
                    key={session.title}
                    className="border-border bg-card rounded-sm border px-4 py-3"
                  >
                    <p className="text-foreground truncate text-[13px]">{session.title}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className={cn('flex items-center gap-1 text-[11px]', s.text)}>
                        <span className={cn('size-1.5 rounded-full', s.dot)} />
                        {s.label}
                      </span>
                      <span className="text-muted-foreground text-[11px]">·</span>
                      <span className="text-muted-foreground text-[11px]">{session.agent}</span>
                      <span className="text-muted-foreground ml-auto truncate font-mono text-[10px]">
                        {session.branch}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 px-6 pt-6">
            <div className="flex items-baseline gap-2">
              <h3 className="text-foreground text-[15px] font-medium">Change requests</h3>
              <span className="text-muted-foreground text-xs">2</span>
            </div>
            <div className="space-y-2">
              {CHANGE_REQUESTS.map((cr) => (
                <div key={cr.title} className="border-border bg-card rounded-sm border px-4 py-3">
                  <p className="text-foreground truncate font-mono text-[12px]">{cr.title}</p>
                  <p className="text-muted-foreground mt-1.5 truncate text-[11px]">{cr.meta}</p>
                  <div className="mt-3 flex gap-2">
                    <span className="bg-foreground text-background rounded-sm px-2 py-1 text-[11px] font-medium">
                      Approve
                    </span>
                    <span className="border-border text-muted-foreground rounded-sm border px-2 py-1 text-[11px]">
                      Request changes
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
