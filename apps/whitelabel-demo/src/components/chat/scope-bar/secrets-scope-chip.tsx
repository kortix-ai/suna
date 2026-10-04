'use client';

/**
 * The Secrets chip: what this session may read, and — when the session is
 * running — the editor that changes it. Presentation only: the queries, the
 * draft state, and the mutations live in ScopeBar; the chip decomposes into
 * the read-only rows and the draft editor, each under 80 lines.
 */

import { CallSnippet } from '@/components/dev/call-snippet';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  ScopeChip,
  ScopeEditor,
  ApplyDraft,
  StartWithScope,
} from '@/components/chat/scope-bar/chip';
import { Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  MISSING_SECRET_NOTE,
  NEW_IDENTIFIER_HINT,
  SECRET_MEMBERSHIP_LABEL,
  classifyTypedIdentifier,
  hasScopeDraft,
  scopeControl,
  type ScopeBarSecrets,
  type ScopeDraftIssue,
  type TypedIdentifier,
} from '../scope-bar-model';
import type { ProjectSecret, SessionScope } from '@kortix/sdk';

interface SecretsChipProps {
  projectId: string;
  sessionId: string;
  authoritativeScope: SessionScope;
  items: ProjectSecret[];
  secretsError: boolean;
  live: ScopeBarSecrets;
  issues: ScopeDraftIssue[];
  draft: string[] | null | undefined;
  nextSecrets: string[] | null;
  setDraftSecrets: (draft: string[] | null | undefined) => void;
  applyScope: { isPending: boolean; mutate: (patch: { secrets?: string[] | null }) => void };
  startAction: ReactNode;
}

export function SecretsScopeChip({
  projectId,
  sessionId,
  authoritativeScope,
  items,
  secretsError,
  live,
  issues,
  draft,
  nextSecrets,
  setDraftSecrets,
  applyScope,
  startAction,
}: SecretsChipProps) {
  return (
    <ScopeChip
      icon={<Lock className="size-3" />}
      label="Secrets"
      // Derived from the session's own allowlist, so it stays true even when
      // the project's secret list is the thing that failed to load.
      value={live.summary}
      title="Secrets"
      badge={scopeControl('secrets').badge}
      // BOTH: what this session's allowlist actually is, and — when the
      // session is running — why the switches below cannot move it. The first
      // version passed only `live.detail`, so the popover offered a wall of
      // controls and never explained that they were frozen; the frozen copy
      // existed and was asserted by a test while being rendered nowhere.
      note={
        scopeControl('secrets').live
          ? live.detail
          : `${live.detail} ${scopeControl('secrets').note}`
      }
    >
      <SecretsChipRows
        authoritativeScope={authoritativeScope}
        secretsError={secretsError}
        live={live}
      />
      <SecretsChipEditor
        projectId={projectId}
        sessionId={sessionId}
        items={items}
        secretsError={secretsError}
        live={live}
        issues={issues}
        draft={draft}
        nextSecrets={nextSecrets}
        setDraftSecrets={setDraftSecrets}
        applyScope={applyScope}
        startAction={startAction}
      />
    </ScopeChip>
  );
}

/** The rows this session's allowlist actually names, plus the missing ones. */
function SecretsChipRows({
  authoritativeScope,
  secretsError,
  live,
}: {
  authoritativeScope: SessionScope;
  secretsError: boolean;
  live: ScopeBarSecrets;
}) {
  return (
    <div className="mt-3 space-y-2">
      {/* An unread project list is not an empty one. "No secrets" here
          would be a claim about secret access that nothing established. */}
      {secretsError && (
        <p className="text-xs text-muted-foreground">
          This project's secrets could not be read just now, so only
          the allowlist itself is shown:{' '}
          {live.narrowed
            ? authoritativeScope.secrets_allowlist?.join(', ') || 'nothing'
            : 'it was never narrowed'}
          .
        </p>
      )}
      {!secretsError && live.rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          This project has no secrets a session allowlist can name.
        </p>
      )}
      {live.rows.map((row) => (
        <div
          key={row.identifier}
          className="flex items-start justify-between gap-2"
        >
          <div className="min-w-0">
            <div className="truncate font-mono text-xs">
              {row.identifier}
            </div>
            {/* The KEY is shown next to every identifier, always: the
                allowlist addresses the identifier, the sandbox sees the
                KEY, and they are routinely different names. */}
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {row.name}
            </div>
          </div>
          <Badge
            variant={row.membership === 'allowed' ? 'outline' : 'ghost'}
            className={
              row.membership === 'excluded'
                ? 'text-muted-foreground'
                : undefined
            }
          >
            {SECRET_MEMBERSHIP_LABEL[row.membership]}
          </Badge>
        </div>
      ))}
      {!secretsError && live.missing.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
          <div className="font-mono text-xs">{live.missing.join(', ')}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {MISSING_SECRET_NOTE}
          </p>
        </div>
      )}
    </div>
  );
}

interface SecretsChipEditorProps {
  projectId: string;
  sessionId: string;
  items: ProjectSecret[];
  secretsError: boolean;
  live: ScopeBarSecrets;
  issues: ScopeDraftIssue[];
  draft: string[] | null | undefined;
  nextSecrets: string[] | null;
  setDraftSecrets: (draft: string[] | null | undefined) => void;
  applyScope: { isPending: boolean; mutate: (patch: { secrets?: string[] | null }) => void };
  startAction: ReactNode;
}

/** The draft editor: the narrow switch, the per-secret switches, the field
 *  for an identifier nobody listed, the apply button, and the start action. */
function SecretsChipEditor({
  projectId,
  sessionId,
  items,
  secretsError,
  live,
  issues,
  draft,
  nextSecrets,
  setDraftSecrets,
  applyScope,
  startAction,
}: SecretsChipEditorProps) {
  const [typed, setTyped] = useState('');
  const toggleSecret = (identifier: string, on: boolean) => {
    const base = nextSecrets ?? [];
    setDraftSecrets(
      on
        ? [...new Set([...base, identifier])]
        : base.filter((id) => id !== identifier),
    );
  };
  const typedState = classifyTypedIdentifier(typed, { secrets: items, draft: nextSecrets ?? [] });

  return (
    <>
      <ScopeEditor
        label="Change what this session may read"
        // No draft editor without the list it edits: a change built on a list
        // that failed to load would name identifiers nobody verified.
        //
        // NOT gated on `secretsFixed` any more. It was, and when secrets became
        // changeable that flag went false and took the ONLY editing controls
        // with it — the popover said "Changeable" over a read-only list.
        show={!secretsError}
      >
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="scope-bar-narrow" className="text-xs font-normal">
            Limit it to a list
          </Label>
          <Switch
            id="scope-bar-narrow"
            checked={nextSecrets !== null}
            onCheckedChange={(on) =>
              setDraftSecrets(on ? (nextSecrets ?? []) : null)
            }
          />
        </div>
        {nextSecrets === null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Off, this session gets its agent's full secret grant — no
            narrowing at all.
          </p>
        ) : (
          <>
            <SecretSwitchRows
              live={live}
              nextSecrets={nextSecrets}
              toggleSecret={toggleSecret}
            />
            <AddIdentifierField
              typed={typed}
              setTyped={setTyped}
              typedState={typedState}
              onAdd={(identifier) => {
                toggleSecret(identifier, true);
                setTyped('');
              }}
            />
          </>
        )}
      </ScopeEditor>
      <SecretsChipApply
        {...{ projectId, sessionId, issues, draft, nextSecrets, applyScope, startAction }}
      />
    </>
  );
}

/** The apply control, the start action, and the call the demo teaches. */
function SecretsChipApply({
  projectId,
  sessionId,
  issues,
  draft,
  nextSecrets,
  applyScope,
  startAction,
}: {
  projectId: string;
  sessionId: string;
  issues: ScopeDraftIssue[];
  draft: string[] | null | undefined;
  nextSecrets: string[] | null;
  applyScope: { isPending: boolean; mutate: (patch: { secrets?: string[] | null }) => void };
  startAction: ReactNode;
}) {
  return (
    <>
      {/* Apply to THIS session. Shown above "start a new session" because it is
          now the ordinary path — starting fresh is the fallback for the one
          thing a re-scope cannot do, not the default. */}
      <ApplyDraft
        show={hasScopeDraft(draft)}
        pending={applyScope.isPending}
        disabled={issues.length > 0}
        onApply={() => applyScope.mutate({ secrets: nextSecrets })}
        caveat="Takes effect on the next prompt. Removing one stops it being handed out — it cannot un-read a value the agent already has, so rotate it if you need it truly revoked."
      />
      {startAction}
      {/* The call behind the control, next to the control — the demo's job is
          to teach what to send, and re-scoping is the least obvious of these. */}
      <CallSnippet id="session.rescope" context={{ projectId, sessionId }} />
    </>
  );
}

/** One switch per allowlistable row, then the drafted identifiers with no row. */
function SecretSwitchRows({
  live,
  nextSecrets,
  toggleSecret,
}: {
  live: ScopeBarSecrets;
  nextSecrets: string[];
  toggleSecret: (identifier: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      {live.rows.map((row) => (
        <div
          key={row.identifier}
          className="flex items-center justify-between gap-3"
        >
          <Label
            htmlFor={`scope-bar-secret-${row.identifier}`}
            className="min-w-0 font-mono text-xs font-normal"
          >
            <span className="truncate">{row.identifier}</span>
            {row.name !== row.identifier && (
              <span className="truncate text-muted-foreground">
                → {row.name}
              </span>
            )}
          </Label>
          <Switch
            id={`scope-bar-secret-${row.identifier}`}
            checked={nextSecrets.includes(row.identifier)}
            onCheckedChange={(on) => toggleSecret(row.identifier, on)}
          />
        </div>
      ))}
      {nextSecrets
        .filter((id) => !live.rows.some((row) => row.identifier === id))
        .map((id) => (
          <div
            key={id}
            className="flex items-center justify-between gap-3"
          >
            <span className="min-w-0 truncate font-mono text-xs">
              {id}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => toggleSecret(id, false)}
            >
              Remove
            </Button>
          </div>
        ))}
    </div>
  );
}

/** Where an identifier nobody listed yet gets typed in. */
function AddIdentifierField({
  typed,
  setTyped,
  typedState,
  onAdd,
}: {
  typed: string;
  setTyped: (value: string) => void;
  typedState: TypedIdentifier;
  /** Called only for an addable identifier — empty and already-listed never
   *  reach it (the button is disabled for both). */
  onAdd: (identifier: string) => void;
}) {
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <Label
        htmlFor="scope-bar-new-identifier"
        className="text-xs font-normal"
      >
        Allow another identifier
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id="scope-bar-new-identifier"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="STRIPE_LIVE"
          className="h-8 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={
            typedState.kind === 'empty' ||
            typedState.kind === 'already_listed'
          }
          onClick={() => {
            if (
              typedState.kind === 'empty' ||
              typedState.kind === 'already_listed'
            ) {
              return;
            }
            onAdd(typedState.identifier);
          }}
        >
          Add
        </Button>
      </div>
      {typedState.kind === 'already_listed' && (
        <p className="text-[11px] text-muted-foreground">
          Already on the list.
        </p>
      )}
      {/* Said where they type it, not after the create fails: this app can
          list a project's secrets but cannot mint one, and an allowlist naming
          an identifier that does not exist is refused at start. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {NEW_IDENTIFIER_HINT}
      </p>
    </div>
  );
}
