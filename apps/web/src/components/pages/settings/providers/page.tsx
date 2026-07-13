'use client';

import Link from 'next/link';
import { ArrowRight, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRuntimeCurrentProject } from '@kortix/sdk/react';

/** Provider credentials are project-scoped and harness-qualified. */
export default function ProvidersPage() {
  const projectId = useRuntimeCurrentProject().data?.id;
  const href = projectId ? `/projects/${projectId}?customize=llm-providers` : '/projects';

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <KeyRound className="text-muted-foreground mx-auto size-6" />
        <h1 className="mt-4 text-lg font-semibold">Model connections are project-scoped</h1>
        <p className="text-muted-foreground mt-2 text-sm text-pretty">
          Configure Claude subscriptions, Anthropic keys, Codex subscriptions, OpenAI keys,
          compatible endpoints, and managed routing in the project’s Customize panel.
        </p>
        <Button asChild className="mt-5" size="sm">
          <Link href={href}>
            {projectId ? 'Manage project connections' : 'Choose a project'}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
