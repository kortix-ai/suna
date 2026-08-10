'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { classifyModelChange } from '@/lib/mid-session-change';
import { qk } from '@/lib/query-keys';
import { getSessionToken } from '@/lib/session';
import { useProjectModels } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Cpu } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Change the model mid-session.
 *
 * A session's model used to be fixed at creation — the runtime read it once at
 * start, so a live session kept it forever. Changing it now re-points the
 * running runtime, which RESTARTS it and therefore ends any in-flight turn.
 * That is why this is a deliberate choice rather than a silent setting.
 *
 * Goes through `/api/session-model` rather than the SDK directly: the upstream
 * field is named after the runtime, and reference-app client code stays
 * provider-neutral (scripts/sdk-boundary.mjs). The route reports whether the
 * change took effect NOW or applies at next start, and we say which — a user
 * told the model changed, whose next answer comes from the old one, has been
 * lied to.
 */
export function ModelSwitcher({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const qc = useQueryClient();
  const models = useProjectModels(workspaceId);

  // The switcher reads its OWN current model through the neutral route, so no
  // caller has to touch the runtime-named field to render it.
  const current = useQuery({
    queryKey: ['session-model', workspaceId, sessionId],
    queryFn: async () => {
      const token = getSessionToken();
      const res = await fetch(
        `/api/session-model?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!res.ok) return { model: null as string | null };
      return (await res.json()) as { model: string | null };
    },
    staleTime: 30_000,
    retry: false,
  });
  const currentModel = current.data?.model ?? null;

  const change = useMutation({
    mutationFn: async (model: string) => {
      const token = getSessionToken();
      const res = await fetch(
        `/api/session-model?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ model }),
        },
      );
      const body = (await res.json()) as {
        model?: string;
        appliedLive?: boolean;
        pushFailed?: boolean;
        detail?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'Could not change the model');
      return body;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: qk.session(workspaceId, sessionId) });
      qc.invalidateQueries({ queryKey: ['session-model', workspaceId, sessionId] });
      // Three outcomes, not two — a stored-but-not-pushed change is NOT a
      // success, and saying so is the whole point of this switcher's doc
      // comment above. See classifyModelChange.
      const outcome = classifyModelChange(result);
      if (outcome.kind === 'half_applied') {
        toast.error(outcome.message, { description: outcome.detail });
        return;
      }
      toast.success(outcome.message);
    },
    onError: (err: Error) => toast.error(err.message || 'Could not change the model'),
  });

  const options = models;
  if (options.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={change.isPending}>
          <Cpu className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate text-xs">{currentModel ?? 'Model'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {options.map((model) => {
          // Models are addressed `<provider>/<model>` — the same ref form the
          // server stores, so what we send round-trips unchanged.
          const id = `${model.providerID}/${model.modelID}`;
          return (
            <DropdownMenuItem
              key={id}
              onClick={() => id !== currentModel && change.mutate(id)}
              className="gap-2"
            >
              {id === currentModel ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span className="truncate text-xs">{model.modelName || id}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
