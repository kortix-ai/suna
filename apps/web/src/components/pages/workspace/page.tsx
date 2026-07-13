'use client';

import Link from 'next/link';
import { ArrowRight, Blocks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRuntimeCurrentProject } from '@kortix/sdk/react';

/**
 * Compatibility landing page for the retired global runtime inspector.
 * Runtime configuration is project-declarative (`kortix.yaml`) and live
 * session state is ACP-scoped, so there is no harness-global tools/config API.
 */
export default function WorkspacePage() {
  const projectId = useRuntimeCurrentProject().data?.id;
  const href = projectId ? `/projects/${projectId}?customize=agents` : '/projects';

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <Blocks className="text-muted-foreground mx-auto size-6" />
        <h1 className="mt-4 text-lg font-semibold">Workspace configuration moved</h1>
        <p className="text-muted-foreground mt-2 text-sm text-pretty">
          Agents, harnesses, models, skills, connectors, and secrets now come from the project’s
          Kortix configuration. Live commands and tool activity come directly from its ACP session.
        </p>
        <Button asChild className="mt-5" size="sm">
          <Link href={href}>
            {projectId ? 'Open project Customize' : 'Choose a project'}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
