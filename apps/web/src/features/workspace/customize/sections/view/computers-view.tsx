'use client';

/**
 * Customize → Computers — the Agent Computer Tunnel surface.
 *
 * Connect a local machine and grant agents permissioned access to its files,
 * shell, and desktop over a reverse tunnel. This is an EXPERIMENTAL feature:
 * the rail entry only appears when a project has opted in
 * (Customize → Settings → Experimental → Agent Computer Tunnel), gated on
 * `project.experimental.agent_tunnel`.
 *
 * Tunnels are account-scoped (a connected computer is reusable across your
 * projects); we surface the manager here so it lives alongside the rest of a
 * project's wiring. {@link TunnelOverview} brings its own page header.
 */

import { TunnelOverview } from '@/components/tunnel/tunnel-overview';

export function ComputersView({ projectId: _projectId }: { projectId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <TunnelOverview />
    </div>
  );
}
