'use client';

/**
 * Commands.
 *
 * This view rendered NOTHING before: `customize-panel`'s section switch never
 * had a `case 'commands'`, so the rail entry that advertised it opened a blank
 * pane, and this file was imported by no one. Commands now share the Skills
 * screen — the same list, the same detail modal, one pill apart — so the
 * capability is reachable again from `/projects/:id/skills?tab=commands`, from
 * the Commands pill, and from this entry point if the overlay ever wires it.
 */

import { SkillsSection } from '@/features/workspace/skills/skills-section';

export function CommandsView({ projectId }: { projectId: string }) {
  return <SkillsSection projectId={projectId} initialKind="command" />;
}

export default CommandsView;
