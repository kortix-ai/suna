'use client';

import { Badge } from '@/components/ui/badge';
import { MID_SESSION_CAPABILITIES } from '@/lib/mid-session-change';
import { Lock, RefreshCw, Repeat } from 'lucide-react';

/**
 * What this session may still change, stated honestly.
 *
 * The three overrides look alike and behave completely differently. Showing a
 * secrets control that cannot work would be worse than showing none — so this
 * shows the LIMIT, with the reason, instead of a disabled input the user will
 * keep poking.
 */
const ROWS = [
  {
    key: 'model' as const,
    label: 'Model',
    icon: RefreshCw,
    badge: 'Changeable now',
    detail: 'Switching restarts the runtime, which ends the in-flight turn.',
  },
  {
    key: 'agent' as const,
    label: 'Agent',
    icon: Repeat,
    badge: 'Per message',
    detail:
      'Each message names the agent that runs it. Switching to an agent with different secret access needs a new session — re-scoping cannot un-read what this session already loaded.',
  },
  {
    key: 'secrets' as const,
    label: 'Secrets',
    icon: Lock,
    badge: 'Fixed at start',
    detail:
      'The secret allowlist is set once when the session starts and never changes. Narrowing it mid-flight could leave the session unable to boot. Start a new session to change it.',
  },
];

export function SessionScope() {
  return (
    <div className="space-y-2">
      {ROWS.map((row) => {
        const Icon = row.icon;
        const fixed = MID_SESSION_CAPABILITIES[row.key] === 'fixed_at_create';
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
              <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
