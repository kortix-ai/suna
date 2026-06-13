'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * Files route — opens the Cmd+K File Search (git-backed search over the
 * project's repo) and drops the user on the project home view as the backdrop.
 * The full file browser still lives in the Customize modal's Files section.
 */
export default function ProjectFilesPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  useEffect(() => {
    if (!id) return;
    router.replace(`/projects/${id}`);
    // Let the palette (mounted in the shell) mount/settle before opening it.
    const t = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('kortix:open-file-search'));
    }, 50);
    return () => clearTimeout(t);
  }, [id, router]);

  return null;
}
