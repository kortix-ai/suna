'use client';

/**
 * /projects/[id]/schedules — Cron-driven triggers only.
 *
 * Thin wrapper around the shared <TriggersView /> with type="cron".
 * Webhook triggers live at /webhooks; both share the same kortix.toml.
 */

import { use } from 'react';

import { TriggersView } from '@/components/projects/triggers-view';

export default function ProjectSchedulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  return <TriggersView projectId={projectId} type="cron" />;
}
