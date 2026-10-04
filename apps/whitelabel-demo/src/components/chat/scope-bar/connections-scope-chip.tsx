'use client';

/**
 * The Connections chip: what this session is bound to, and the picker that
 * changes it. Presentation only: the queries, the draft state, and the
 * mutations live in ScopeBar.
 */

import { ConnectorBindingFields } from '@/components/connector-bindings';

import { CallSnippet } from '@/components/dev/call-snippet';
import { AlertTriangle } from 'lucide-react';
import { Plug } from 'lucide-react';
import {
  ScopeChip,
  ScopeEditor,
  ApplyDraft,
  StartWithScope,
} from '@/components/chat/scope-bar/chip';
import { hasScopeDraft, scopeControl, type ScopeBarConnectors } from '../scope-bar-model';
import type { ConnectorBindingChoice } from '@/server/bindable-connections';
import type { ReactNode } from 'react';

/** The rows this session is bound to, with each unavailable alias's reason. */
function ConnectionRows({ connections }: { connections: ScopeBarConnectors }) {
  return (
    <div className="mt-3 space-y-2">

      {connections.rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          This project has no connectors connected yet.
        </p>
      )}
      {connections.rows.map((row) => (
        <div key={row.alias} className="space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-muted-foreground">
              {row.alias}
            </span>
            <span className="truncate text-xs">
              {row.bound ?? 'Project default'}
            </span>
          </div>
          {/* The remedy is always a teammate. A wrapper acts under one
              credential for many end-users, so it has no upstream identity
              to connect WITH, and the interactive flow that would is
              refused for it outright. */}
          {row.notice && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs">{row.notice.title}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {row.notice.detail}
                </p>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ConnectionsScopeChip({
  projectId,
  sessionId,
  connections,
  choices,
  draft,
  nextBindings,
  setDraftBindings,
  applyScope,
  startAction,
}: {
  projectId: string;
  sessionId: string;
  connections: ScopeBarConnectors;
  choices: ConnectorBindingChoice[];
  draft: Record<string, string> | undefined;
  nextBindings: Record<string, string>;
  setDraftBindings: (bindings: Record<string, string> | undefined) => void;
  applyScope: { isPending: boolean; mutate: (patch: { bindings?: Record<string, string> }) => void };
  startAction: ReactNode;
}) {
  return (
    <ScopeChip
      icon={<Plug className="size-3" />}
      label="Connections"
      value={connections.summary}
      title="Connections"
      badge={scopeControl('connections').badge}
      note={scopeControl('connections').note}
    >
      <ConnectionRows connections={connections} />

      <ScopeEditor
        label="Bind different accounts for this session"
        // Same fix as secrets: gating on `connectionsFixed` hid the picker the
        // moment bindings became changeable, so the popover offered nothing.
        show={choices.some((choice) => choice.connections.length > 0)}
      >
        <ConnectorBindingFields
          // Only the aliases with something to bind — the unavailable ones
          // are explained once, above, and a second copy of the same notice
          // reads like a second problem.
          choices={choices.filter((choice) => choice.connections.length > 0)}
          value={nextBindings}
          onChange={setDraftBindings}
        />
      </ScopeEditor>
      {/* Same control as secrets, different guarantee: a binding is resolved
          server-side on every tool call, so this one IS fully effective — the
          copy must not borrow the secrets caveat. */}
      <ApplyDraft
        show={hasScopeDraft(draft)}
        pending={applyScope.isPending}
        onApply={() => applyScope.mutate({ bindings: nextBindings })}
        caveat="Takes effect on the next tool call — connections resolve server-side, so unlike secrets this change is complete. An alias you unbind falls back to the project default."
      />
      {startAction}
      <CallSnippet id="session.rescope" context={{ projectId, sessionId }} />
    </ScopeChip>
  );
}
