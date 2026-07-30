'use client';

/**
 * "Which account does this session act as?" — for every connector the project
 * has connections for, not one hardcoded alias.
 *
 * Two states, and the difference between them is the thing people get wrong:
 *  - team connections exist → pick one (or leave it on the project default)
 *  - none do → say so, and say that a TEAMMATE is the one who can change it.
 *    There is deliberately no "connect it yourself" button; a wrapper has no
 *    personal upstream identity, and the interactive flow that would connect
 *    one is refused for a wrapper credential (see `connectorBindingNotice`).
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { connectorBindingNotice } from '@/lib/connector-binding';
import { getSessionToken } from '@/lib/session';
import type { ConnectorBindingChoice } from '@/server/bindable-connections';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';

const DEFAULT_VALUE = 'default';

/** Every alias the project has connections for, with what may be bound. */
export function useConnectorBindingChoices(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ['connector-binding-choices', projectId],
    queryFn: async () => {
      const token = getSessionToken();
      const res = await fetch(
        `/api/connections?projectId=${encodeURIComponent(projectId)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        },
      );
      if (!res.ok) return { connectors: [] as ConnectorBindingChoice[] };
      return (await res.json()) as { connectors: ConnectorBindingChoice[] };
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function ConnectorBindingFields({
  choices,
  value,
  onChange,
}: {
  choices: ConnectorBindingChoice[];
  /** Alias -> authorization id. An alias absent from this map stays on the default. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  if (choices.length === 0) return null;

  const set = (alias: string, authorizationId: string | null) => {
    const next = { ...value };
    // Unbinding REMOVES the alias rather than storing an empty string: the
    // create body must omit it entirely so the server resolves its own default.
    if (authorizationId) next[alias] = authorizationId;
    else delete next[alias];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {choices.map((choice) => {
        const notice = connectorBindingNotice(choice);
        if (notice) {
          return (
            <div
              key={choice.alias}
              className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5"
            >
              <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm">{notice.title}</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {notice.detail}
                </p>
              </div>
            </div>
          );
        }

        return (
          <div
            key={choice.alias}
            className="flex items-center justify-between gap-3"
          >
            <span className="truncate font-mono text-xs text-muted-foreground">
              {choice.alias}
            </span>
            <Select
              value={value[choice.alias] ?? DEFAULT_VALUE}
              onValueChange={(v) =>
                set(choice.alias, v === DEFAULT_VALUE ? null : v)
              }
            >
              <SelectTrigger
                className="h-8 w-56 text-xs"
                aria-label={`Connection for ${choice.alias}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>Project default</SelectItem>
                {choice.connections.map((connection) => (
                  <SelectItem
                    key={connection.authorizationId}
                    value={connection.authorizationId}
                  >
                    {connection.label}
                    {connection.isDefault ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
