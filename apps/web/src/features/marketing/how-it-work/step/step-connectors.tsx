'use client';

import { ok, t } from '@/components/home/interactive-demo/cli/terminal';
import { BrandLogo, ConnectBadge, PageHead } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { LockKeyIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useCliMovie, type Stage } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

/** The six shown in the grid, in the order they read. */
const SHOWN: [domain: string, name: string][] = [
  ['github.com', 'GitHub'],
  ['slack.com', 'Slack'],
  ['linear.app', 'Linear'],
  ['notion.so', 'Notion'],
  ['hubspot.com', 'HubSpot'],
  ['stripe.com', 'Stripe'],
];

/**
 * The connector providers, minus `pipedream` (that is the app catalog above)
 * and minus the two internal ones. Source: `ConnectorProvider` in
 * `apps/api/src/projects/connectors.ts`.
 */
const BYO_KINDS = ['MCP', 'OpenAPI', 'Postman', 'GraphQL', 'HTTP'];

type ConnectorsState = {
  connected: string[];
  /** The per-tool rule the second command writes, shown on the Linear row. */
  rule: string | null;
};

const INITIAL: ConnectorsState = { connected: ['GitHub', 'Slack'], rule: null };

/**
 * Both commands exist: `connectors connect <slug>` starts the 1-click connect,
 * and `connectors policy <slug> set <match> <allow|ask|block>` writes the rule
 * that decides whether a tool call runs or stops to ask.
 */
const SCRIPT: Stage<ConnectorsState>[] = [
  {
    run: 'kortix connectors connect linear',
    out: [
      {
        line: ok(t('Linear connected · '), t('12 tools', 'faded')),
        state: { connected: ['GitHub', 'Slack', 'Linear'] },
        pause: 900,
      },
    ],
  },
  {
    run: 'kortix connectors policy linear set create_issue ask',
    out: [{ line: ok(t('create_issue → '), t('ask', 'fg')), state: { rule: 'create_issue · ask' } }],
  },
];

function ConnectorsView({ state }: { state: ConnectorsState }): ReactNode {
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Connectors"
        sub="Connect once, for the whole company."
        action={
          <Badge variant="kortix" size="sm" className="shrink-0 rounded">
            3,000+ apps
          </Badge>
        }
      />

      {/* Two columns, never three. The card gives this panel about 500px, and
          a third column truncates every connector name to one letter. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SHOWN.map(([domain, name]) => {
          const connected = state.connected.includes(name);
          const rule = name === 'Linear' ? state.rule : null;
          return (
            <m.div
              key={name}
              layout
              className={cn(
                'border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5',
                rule && 'border-kortix-green/40',
              )}
            >
              <BrandLogo domain={domain} alt={name} size={18} />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">{name}</span>
                {rule ? (
                  <span className="text-muted-foreground block truncate font-mono text-[10px]">
                    {rule}
                  </span>
                ) : null}
              </span>
              <ConnectBadge connected={connected} />
            </m.div>
          );
        })}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="border-border/60 bg-card rounded-md border px-4 py-3">
          <div className="text-foreground text-sm font-medium">Not in the catalog?</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {BYO_KINDS.map((kind) => (
              <span
                key={kind}
                className="border-border text-muted-foreground rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wide"
              >
                {kind}
              </span>
            ))}
          </div>
        </div>

        <div className="border-border/60 bg-muted/20 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs leading-relaxed">
          <LockKeyIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Credentials are brokered server-side. The agent calls the tool; the token never enters
            the machine.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Layer 02 — every tool the company already runs on, and who may call it. */
export function StepConnectors(): ReactNode {
  const movie = useCliMovie(INITIAL, SCRIPT);
  const rootRef = useStepShowcaseStart(movie.start);

  return (
    <div
      ref={rootRef}
      className="grid h-full w-full grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
    >
      <div className="min-h-0">
        <WebPanelWrapper activeTab="connectors">
          <ConnectorsView state={movie.state} />
        </WebPanelWrapper>
      </div>

      {/* The terminal is a column, not a floating window: at 1100px wide the
          card has room for both surfaces side by side, and a draggable overlay
          would only cover the panel it is meant to be driving. */}
      <div className="hidden min-h-0 lg:block">
        <StepCliTerminal director={movie} />
      </div>
    </div>
  );
}
