'use client';

import { PageHead, Panel, Row } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { BrainIcon, RobotIcon, SparkleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

/**
 * The real manifest, at panel scale.
 *
 * ACCURACY GATE — this is a COMPLETE `kortix_version: 2` manifest, not a
 * fragment: it parses and validates clean against `packages/manifest-schema`
 * (`validateManifest(text, 'yaml')` → `valid: true`, zero issues, zero
 * warnings). Keep it that way. The rules the validator enforces, and that this
 * snippet must not break:
 *   - `default_agent` is required and must name a declared agent.
 *   - `channels:` is rejected outright in version 2 — channel routing is live
 *     project state, not manifest config. Never add one.
 *   - Agent behaviour (model, mode, prompt, permission) is a hard error here —
 *     it lives in `.kortix/opencode/agents/<name>.md`. The manifest grants only.
 *   - A `triggers:` entry needs a `prompt`, so one trigger costs six lines.
 *     That is why this panel leaves triggers to `/company-as-code`.
 *   - An omitted grant resolves to `none`, which is what the header claims.
 *   - `secrets:` grants secret NAMES. The values never enter the repo — but a
 *     granted secret IS a real env value inside the session, so never write
 *     that it is hidden from the model.
 * Northwind is a placeholder, not a customer.
 */
const MANIFEST: { id: string; line: string; tone?: 'muted' | 'accent' }[] = [
  { id: 'version', line: 'kortix_version: 2' },
  { id: 'default-agent', line: 'default_agent: kortix' },
  { id: 'agents', line: 'agents:' },
  { id: 'kortix-agent', line: '  kortix:' },
  { id: 'kortix-connectors', line: '    connectors: all' },
  { id: 'kortix-secrets', line: '    secrets: all' },
  { id: 'kortix-skills', line: '    skills: all' },
  { id: 'invoice-clerk-agent', line: '  invoice-clerk:' },
  { id: 'invoice-clerk-connectors', line: '    connectors: [gmail-read]', tone: 'accent' },
  { id: 'invoice-clerk-skills', line: '    skills: [reconcile-invoices]', tone: 'accent' },
];

/**
 * Real directories from the shipped starter template
 * (`packages/starter/templates/base/.kortix`). Do not invent one.
 */
const REPO = [
  {
    icon: RobotIcon,
    path: 'opencode/agents/',
    note: 'one OpenCode agent per file',
  },
  {
    icon: SparkleIcon,
    path: 'opencode/skills/',
    note: 'how this company does a job',
  },
  {
    icon: BrainIcon,
    path: 'memory/',
    note: 'what it has learned so far',
  },
];

/**
 * Layer 01 — the repo is the company, and `kortix.yaml` is the part that
 * governs it.
 *
 * Two columns, because this panel's frame is wide and short (measured 1076 x
 * 213 at a 1440 viewport): one stacked column pushed the scoped-grant lines —
 * the whole point of the manifest — far below the fold. Below `sm` the frame is
 * narrow instead, so the grid collapses back to one column.
 */
export function StepSourceOfTruth(): ReactNode {
  return (
    <WebPanelWrapper activeTab="workspaces">
      <PageHead
        title="Source of truth"
        sub="One git repo holds the whole company."
        action={
          <Badge variant="kortix" size="sm" className="shrink-0 rounded">
            main
          </Badge>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Panel title="kortix.yaml" count="omit a grant and it is none">
          <div className="bg-background px-4 py-3">
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll this overflowing code region, as required by Axe.
              tabIndex={0}
              aria-label="Kortix project manifest"
              className="overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
            >
              <code>
                {MANIFEST.map((entry) => (
                  <div
                    key={entry.id}
                    className={
                      entry.tone === 'muted'
                        ? 'text-muted-foreground/55'
                        : entry.tone === 'accent'
                          ? 'text-foreground'
                          : 'text-foreground/85'
                    }
                  >
                    {entry.line === '' ? ' ' : entry.line}
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </Panel>

        <Panel title=".kortix/" count="and the rest is files">
          {REPO.map((entry) => (
            <Row
              key={entry.path}
              leading={
                <span className="border-border bg-background text-muted-foreground flex size-8 items-center justify-center rounded-md border">
                  <entry.icon className="size-4" />
                </span>
              }
              title={<span className="font-mono text-[12.5px]">{entry.path}</span>}
              subtitle={entry.note}
            />
          ))}
        </Panel>
      </div>
    </WebPanelWrapper>
  );
}
