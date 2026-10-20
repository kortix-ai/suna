'use client';

import { useParams } from 'next/navigation';

import { SecretsPage } from '@kortix/ui/customize/secrets/secrets-page';

/**
 * /projects/[id]/secrets — the standalone Secrets page. See
 * `packages/ui/src/customize/secrets/secrets-page.tsx` for the page
 * body.
 */
export default function ProjectSecretsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SecretsPage projectId={projectId} />
    </div>
  );
}
