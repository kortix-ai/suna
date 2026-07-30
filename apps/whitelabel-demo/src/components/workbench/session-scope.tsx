'use client';

/**
 * What THIS session is scoped to, and what it can still change.
 *
 * This panel used to print the same three paragraphs for every session. The
 * rules were right and the answers were missing: "can I switch the agent?"
 * depends on which agent this session booted with, and "what can it read?" is
 * a list that exists on the session. So every row shows the session's real
 * state, the model row carries the real control, and the frozen rows explain
 * why THIS session cannot move rather than restating the rule in the abstract.
 */

import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ModelSwitcher } from '@/components/workbench/model-switcher';
import type { CallSnippetId } from '@/lib/call-snippets';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { isFixedAtStart, readBoundConnections, sessionScopeIsReadable, sessionScopeRows, type ScopeRowKey } from '@/lib/session-scope';
import { useQuery } from '@tanstack/react-query';
import { Lock, Plug, RefreshCw, Repeat } from 'lucide-react';

const ICONS: Record<ScopeRowKey, typeof Lock> = {
  model: RefreshCw,
  agent: Repeat,
  secrets: Lock,
  connections: Plug,
};

/**
 * The call that MOVES a row — only the two rows that can still move have one.
 * The frozen rows share the create call below, because the honest answer to
 * "how do I change this?" is "you don't, you start a session".
 */
const ROW_CALL: Partial<Record<ScopeRowKey, CallSnippetId>> = {
  model: 'session.model',
  agent: 'session.prompt',
};

export function SessionScope({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: qk.session(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).get({ showErrors: false }),
    retry: false,
  });

  if (session.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-md" />
        ))}
      </div>
    );
  }

  // "Couldn't read it" must not render as "it isn't narrowed": every row below
  // is a claim about what this session may reach, and a wrong one here is
  // worse than none.
  //
  // A REDACTED row is the trap here, and it arrives as a perfectly good HTTP 200:
  // the serializer blanks an inaccessible session to `metadata: {}` and
  // `secrets_allowlist: null` — and `null` is precisely the value this panel
  // reads as "everything the agent grant allows". So a session the caller may
  // NOT open would render as LESS restricted than one they may. `can_access` is
  // on the payload for exactly this; not reading it turns a redaction into a
  // false reassurance.
  if (!sessionScopeIsReadable(session.data)) {
    return (
      <p className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
        This session&apos;s scope could not be read just now. Reopen the session to try again.
      </p>
    );
  }

  // Read once, out here: the readability check above narrows `session.data`,
  // and that narrowing does not survive into the row callbacks below.
  const agentName = session.data.agent_name ?? null;
  const rows = sessionScopeRows({
    agentName: session.data.agent_name,
    // null = never narrowed, which is the opposite of an empty allowlist.
    secretsAllowlist: session.data.secrets_allowlist ?? null,
    boundConnections: readBoundConnections(session.data.metadata),
  });

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const Icon = ICONS[row.key];
        const fixed = isFixedAtStart(row.key);
        return (
          <div
            key={row.key}
            className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5"
          >
            <Icon
              className={`mt-0.5 size-4 shrink-0 ${fixed ? 'text-muted-foreground' : 'text-brand'}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{row.label}</span>
                <Badge variant={fixed ? 'secondary' : 'outline'} className="text-xs">
                  {row.badge}
                </Badge>
              </div>
              {row.control === 'model' && (
                <div className="-ml-2 mt-0.5">
                  <ModelSwitcher projectId={projectId} sessionId={sessionId} />
                </div>
              )}
              {row.value !== null && (
                <div className="mt-0.5 break-words font-mono text-xs">{row.value}</div>
              )}
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.detail}</p>
              {ROW_CALL[row.key] && (
                <div className="-ml-2 mt-1">
                  <CallSnippet
                    id={ROW_CALL[row.key]!}
                    context={{ projectId, sessionId, agent: agentName }}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Everything frozen above was decided in ONE request. Showing it here is
          the difference between "you can't change this" and "here is where it
          was chosen" — filled in from what this session actually reports, so it
          is this session's call rather than an example of one. */}
      <div className="rounded-md border border-dashed border-border px-3 py-2.5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          The frozen rows were fixed by the call that opened this session. The agent and the
          allowlist below are read back from the session; connector bindings are not — the platform
          accepts them at create and never serializes them, which is why Lumen keeps its own record.
        </p>
        <div className="-ml-2 mt-1">
          <CallSnippet
            id="session.create"
            context={{
              projectId,
              sessionId,
              overrides: {
                agent: agentName,
                secrets: session.data.secrets_allowlist ?? null,
                bindings: {}, runtimeContext: null },
            }}
          />
        </div>
      </div>
    </div>
  );
}
