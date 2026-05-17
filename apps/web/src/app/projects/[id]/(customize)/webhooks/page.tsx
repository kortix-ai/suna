'use client';

/**
 * /projects/[id]/webhooks — Signed HTTP webhook triggers only.
 *
 * Thin wrapper around the shared <TriggersView /> with type="webhook".
 * Cron triggers live at /schedules; both share the same kortix.toml.
 */

import { use } from 'react';

import { TriggersView } from '@/components/projects/triggers-view';

export default function ProjectWebhooksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <TriggersView projectId={projectId} type="webhook" />;
}
