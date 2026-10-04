'use client';

/** `.files.archive` — download a zip of the whole repo at a ref. */

import { kortix } from '@/lib/kortix';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Ref archived/read by default — the repo tip. */
export const DEFAULT_ARCHIVE_REF = 'HEAD';

export function useProjectArchive(projectId: string) {
  return useMutation({
    mutationFn: () => kortix.project(projectId).files.archive(DEFAULT_ARCHIVE_REF),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${projectId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Archive downloaded');
    },
    onError: () => toast.error('Could not download archive'),
  });
}
