'use client';

import {
  BrandLogo,
  ConnectBadge,
  PageHead,
  Panel,
  Row,
} from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Check, GitPullRequest, ShieldCheck } from 'lucide-react';

/**
 * Step visuals for the hero flow.
 *
 * Every step can be shown two ways — the UI a non-technical person sees, and
 * the developer equivalent for the same action. Cropped product screenshots
 * were doing neither well: too small to read, and they only ever showed the UI.
 *
 * The UI panels are built from the same interactive-demo primitives the current
 * homepage uses (`Panel`, `Row`, `PageHead`), so they inherit that visual
 * language instead of inventing a third one.
 */

/* ── shared ──────────────────────────────────────────────────────────────── */

/**
 * A static terminal block. Deliberately not the demo's `CliTerminal`, which is
 * bound to the interactive-demo director state machine and can't be rendered
 * standalone.
 */
export function CliBlock({ file, lines }: { file: string; lines: readonly string[] }) {
  return (
    <div className="bg-card flex h-full flex-col overflow-hidden rounded-xl border shadow-2xl">
      <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
        <span className="flex gap-1.5" aria-hidden="true" data-a11y-decorative>
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="ml-1">{file}</span>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4 font-mono text-xs leading-relaxed sm:text-sm">
        {lines.map((line, i) => (
          <CliLine key={`${i}:${line}`} line={line} />
        ))}
      </div>
    </div>
  );
}

/** Dims comments and tints the prompt marker so output reads at a glance. */
function CliLine({ line }: { line: string }) {
  if (line.startsWith('$ ')) {
    return (
      <div className="whitespace-pre">
        <span className="text-kortix-green">$</span>
        <span className="text-foreground/85">{line.slice(1)}</span>
      </div>
    );
  }
  const comment = line.search(/(^|\s)#/);
  if (comment >= 0) {
    return (
      <div className="whitespace-pre">
        <span className="text-foreground/85">{line.slice(0, comment)}</span>
        <span className="text-muted-foreground/55">{line.slice(comment)}</span>
      </div>
    );
  }
  return <div className="text-foreground/85 whitespace-pre">{line || ' '}</div>;
}

/** The light chrome every mocked UI panel sits in. */
function UiFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card h-full overflow-hidden rounded-xl border p-4 shadow-2xl">
      {children}
    </div>
  );
}

/* ── per-step UI panels ──────────────────────────────────────────────────── */

function AgentsUi() {
  return (
    <UiFrame>
      <PageHead title="Agents" sub="Native harness agents, scoped by kortix.yaml" />
      <div className="mt-3 space-y-2">
        <Panel title="kortix" count="primary">
          <div className="bg-border grid grid-cols-2 gap-px">
            {[
              ['Harness', 'Claude Code'],
              ['Model', 'claude-opus-5'],
              ['Connectors', 'all'],
              ['Secrets', 'all'],
            ].map(([k, v]) => (
              <div key={k} className="bg-card px-3 py-2">
                <div className="text-muted-foreground text-xs">{k}</div>
                <div className="text-foreground mt-0.5 font-mono text-xs">{v}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="finance-analyst" count="scoped">
          <div className="bg-border grid grid-cols-2 gap-px">
            {[
              ['Harness', 'Codex'],
              ['Model', 'gpt-5.6'],
              ['Connectors', 'stripe, sheets'],
              ['Secrets', 'STRIPE_API_KEY'],
            ].map(([k, v]) => (
              <div key={k} className="bg-card px-3 py-2">
                <div className="text-muted-foreground text-xs">{k}</div>
                <div className="text-foreground mt-0.5 font-mono text-xs">{v}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

function SkillsUi() {
  // Real skills from the Kortix marketplace — see the `Kortix` and
  // `Anthropic Skills` sources in Customize → Marketplace.
  const skills = [
    ['account-research', 'Full picture of a company before outreach'],
    ['close-checklist', 'Month-end tolerances and sign-off steps'],
    ['contract-playbook', 'Redline against our standard positions'],
    ['churn-signals', 'Score usage decline and support sentiment'],
    ['competitor-diff', 'Fetch, normalize, diff against the last run'],
    ['brand-guidelines', 'Apply our colours, type, and tone to any asset'],
  ] as const;

  return (
    <UiFrame>
      <PageHead title="Skills" sub="Reusable know-how that rides into every session" />
      <div className="mt-3">
        <Panel count="115 in the marketplace">
          <div className="bg-border grid gap-px">
            {skills.map(([name, desc]) => (
              <Row
                key={name}
                leading={
                  <span className="bg-kortix-purple/15 flex size-8 shrink-0 items-center justify-center rounded-sm">
                    <Check className="text-kortix-purple size-4" />
                  </span>
                }
                title={<span className="font-mono text-xs">{name}</span>}
                subtitle={desc}
              />
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

/**
 * Context — a mocked connector grid rather than the screenshot it replaced.
 *
 * The screenshot read fine on its own but was the only non-mock left in the
 * carousel, so it broke the visual rhythm every time the step came round.
 */
function ContextUi() {
  const apps = [
    ['stripe.com', 'Stripe', 'Payments', true],
    ['slack.com', 'Slack', 'Communication', true],
    ['google.com', 'Google Drive', 'Files', true],
    ['notion.so', 'Notion', 'Docs', true],
    ['salesforce.com', 'Salesforce', 'CRM', true],
    ['linear.app', 'Linear', 'Tickets', false],
    ['github.com', 'GitHub', 'Code', true],
    ['hubspot.com', 'HubSpot', 'CRM', false],
  ] as const;

  return (
    <UiFrame>
      <PageHead title="Connectors" sub="3,000+ apps, plus MCP, OpenAPI, and plain HTTP" />
      <div className="mt-3">
        <Panel count="6 connected">
          <div className="bg-border grid grid-cols-2 gap-px">
            {apps.map(([domain, name, category, connected]) => (
              <div key={name} className="bg-card flex items-center gap-2.5 px-3 py-2.5">
                <BrandLogo domain={domain} alt={name} size={18} />
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-xs font-medium">{name}</div>
                  <div className="text-muted-foreground truncate text-xs">{category}</div>
                </div>
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    connected ? 'bg-kortix-green' : 'bg-muted-foreground/30',
                  )}
                />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

function ModelsUi() {
  const providers = [
    ['anthropic.com', 'Anthropic', 'Your key', true],
    ['openai.com', 'OpenAI', 'ChatGPT subscription', true],
    ['google.com', 'Google', 'Vertex / Gemini', true],
    ['openrouter.ai', 'OpenRouter', 'Not connected', false],
  ] as const;

  return (
    <UiFrame>
      <PageHead title="Models" sub="Your keys, your subscriptions, or managed credits" />
      <div className="mt-3">
        <Panel count="4 providers">
          <div className="bg-border grid gap-px">
            {providers.map(([domain, name, mode, connected]) => (
              <Row
                key={name}
                leading={<BrandLogo domain={domain} alt={name} size={20} />}
                title={name}
                subtitle={mode}
                trailing={<ConnectBadge connected={connected} />}
              />
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

function ApprovalUi() {
  return (
    <UiFrame>
      <PageHead title="Change request" sub="Nothing reaches main without a review" />
      <div className="mt-3 space-y-2">
        <Panel>
          <div className="flex items-start gap-3 px-3 py-3">
            <span className="bg-kortix-green/15 flex size-8 shrink-0 items-center justify-center rounded-sm">
              <GitPullRequest className="text-kortix-green size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">July payout reconciliation</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                finance-analyst → main · 2 files · +148 −12
              </p>
            </div>
            <Badge variant="kortix" size="sm" className="shrink-0 rounded">
              Awaiting review
            </Badge>
          </div>
        </Panel>

        <Panel title="Policy" count="approval gates">
          <div className="bg-border grid gap-px">
            {[
              ['Edit files in /workspace', 'Allowed', 'allow'],
              ['Run git push', 'Ask first', 'ask'],
              ['Delete a connector', 'Blocked', 'block'],
            ].map(([action, verdict, kind]) => (
              <Row
                key={action}
                leading={
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-sm',
                      kind === 'allow' && 'bg-kortix-green/15',
                      kind === 'ask' && 'bg-kortix-orange/15',
                      kind === 'block' && 'bg-kortix-red/15',
                    )}
                  >
                    <ShieldCheck
                      className={cn(
                        'size-4',
                        kind === 'allow' && 'text-kortix-green',
                        kind === 'ask' && 'text-kortix-orange',
                        kind === 'block' && 'text-kortix-red',
                      )}
                    />
                  </span>
                }
                title={<span className="font-mono text-xs">{action}</span>}
                trailing={<span className="text-muted-foreground text-xs">{verdict}</span>}
              />
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

function ExecutionUi() {
  const steps = [
    ['Boot computer', 'done'],
    ['Pull Stripe payouts', 'done'],
    ['Read the ledger', 'done'],
    ['Reconcile and flag', 'running'],
    ['Open change request', 'todo'],
  ] as const;

  return (
    <UiFrame>
      <PageHead title="Session" sub="finance-analyst · own computer · branch s_7f3a" />
      <div className="mt-3">
        <Panel title="Progress" count="4 of 5">
          <div className="bg-border grid gap-px">
            {steps.map(([label, state]) => (
              <Row
                key={label}
                leading={
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-sm',
                      state === 'done' && 'bg-kortix-green/15',
                      state === 'running' && 'bg-kortix-blue/15',
                      state === 'todo' && 'bg-muted',
                    )}
                  >
                    {state === 'done' ? (
                      <Check className="text-kortix-green size-4" />
                    ) : (
                      <span
                        className={cn(
                          'size-2 rounded-full',
                          state === 'running' ? 'bg-kortix-blue' : 'bg-muted-foreground/40',
                        )}
                      />
                    )}
                  </span>
                }
                title={
                  <span
                    className={cn(
                      'text-sm',
                      state === 'todo' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {label}
                  </span>
                }
              />
            ))}
          </div>
        </Panel>
      </div>
    </UiFrame>
  );
}

/* ── registry ────────────────────────────────────────────────────────────── */

export const stepUiPanels = {
  context: ContextUi,
  agents: AgentsUi,
  skills: SkillsUi,
  models: ModelsUi,
  execution: ExecutionUi,
  approval: ApprovalUi,
} as const;

export type StepUiPanelId = keyof typeof stepUiPanels;
