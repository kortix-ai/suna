'use client';

import { CodePanel } from '@/features/marketing/code-panel';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { auditOutputs, groupMappings, policyYaml, roleTable, topics, type TopicId } from './content';
import { Window } from '@/features/marketing/enterprise/parts';
import { TopicTabs } from '@/features/marketing/enterprise/topic-tabs';

/*
 * One focused visual per topic tab. Each fits the tab's panel at 390 px: one
 * column, base-size labels, rows that wrap.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function IdentityPanel() {
  return (
    <Window title="Identity → Group mappings">
      <ul className="flex flex-col divide-y">
        <li className="flex items-center gap-3 px-4 py-2.5">
          <span className={`${caption} flex-1`}>Directory group</span>
          <span aria-hidden className="w-4" />
          <span className={`${caption} flex-1`}>Kortix group</span>
        </li>
        {groupMappings.map((m) => (
          <li key={m.claim} className="flex items-center gap-3 px-4 py-3">
            <code className="text-muted-foreground min-w-0 flex-1 font-mono text-xs break-all sm:text-sm">{m.claim}</code>
            <ArrowRightIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="text-foreground min-w-0 flex-1 text-sm font-medium">{m.group}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

function AccessPanel() {
  return (
    <ul className="bg-background flex flex-col divide-y rounded-lg border">
      {roleTable.map((r) => (
        <li key={r.scope} className="flex flex-col gap-2 p-4">
          <span className={caption}>{r.scope}</span>
          <div className="flex flex-wrap gap-2">
            {r.roles.map((role) => (
              <span key={role} className="text-foreground rounded-sm border px-2 py-0.5 text-sm">
                {role}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AuditPanel() {
  return (
    <ul className="bg-background flex flex-col divide-y rounded-lg border">
      {auditOutputs.map((o) => (
        <li key={o.k} className="flex flex-col gap-1 p-4">
          <span className="text-foreground text-base font-medium">{o.k}</span>
          <span className="text-muted-foreground text-sm text-pretty">{o.v}</span>
        </li>
      ))}
    </ul>
  );
}



const PANELS: Record<TopicId, () => ReactNode> = {
  identity: () => <IdentityPanel />,
  access: () => <AccessPanel />,
  governance: () => <CodePanel title={policyYaml.title} lines={policyYaml.lines} lang="yaml" />,
  audit: () => <AuditPanel />,
};

/** The how-it-works tabs, one per control. */
export function ComplianceTopics() {
  return <TopicTabs topics={topics} panels={PANELS} label="How the controls work" />;
}
