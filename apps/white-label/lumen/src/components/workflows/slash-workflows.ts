'use client';

// Lumen's workflows in a chat's "/" menu: the same list the home composer shows
// (the firm's workflows, then the four built-in ones). The harness's own
// commands never appear (`runtimeSlashEnabled: false` in providers.tsx).
import { useFirmOrNull } from '@/components/access';
import { api } from '@convex/_generated/api';
import type { UiSlashAction } from '@kortix/ui';
import { useQuery } from 'convex/react';
import { useParams, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { workflowPrompt } from './firm-workflows';

/** Lumen's own workflows, as the "/" menus and the home quick actions list them. */
export const BUILT_IN_WORKFLOWS = [
  { kind: 'contract', name: 'Review a contract', hint: 'Against a firm playbook' },
  { kind: 'diligence', name: 'Due diligence', hint: 'Report with red flags' },
  { kind: 'draft', name: 'Draft from template', hint: 'A Word file from a precedent' },
  { kind: 'review', name: 'Tabular review', hint: 'Documents × questions' },
] as const;
export type BuiltInWorkflow = (typeof BUILT_IN_WORKFLOWS)[number];

/** Where a built-in workflow starts on a matter. */
export function builtInHref(kind: BuiltInWorkflow['kind'], matterId: string): string {
  return kind === 'review' ? `/app/matters/${matterId}/reviews/new` : `/app/matters/${matterId}/workflows?open=${kind}`;
}

const NONE: readonly UiSlashAction[] = [];

/**
 * The "/" rows of a matter chat. An assistant workflow puts its instructions in
 * the composer; a tabular workflow and a built-in one open on the matter.
 */
export function useLumenSlashActions(): readonly UiSlashAction[] {
  const firm = useFirmOrNull();
  const matterId = useParams<{ matterId?: string }>()?.matterId;
  const router = useRouter();
  const workflows = useQuery(api.customWorkflows.list, firm ? { firmId: firm._id } : 'skip');
  return useMemo(() => {
    if (!matterId) return NONE;
    return [
      ...(workflows ?? []).map((w): UiSlashAction => ({
        id: w._id,
        label: w.name,
        description: w.type === 'assistant' ? 'Your workflow' : `Review · ${w.columns?.length ?? 0} columns`,
        group: 'Workflows',
        onSelect: () => (w.type === 'assistant' ? { insertText: workflowPrompt(w, '') } : router.push(`/app/matters/${matterId}/workflows?use=${w._id}`)),
      })),
      ...BUILT_IN_WORKFLOWS.map((b): UiSlashAction => ({
        id: b.kind,
        label: b.name,
        description: b.hint,
        group: 'Workflows',
        onSelect: () => router.push(builtInHref(b.kind, matterId)),
      })),
    ];
  }, [matterId, workflows, router]);
}
