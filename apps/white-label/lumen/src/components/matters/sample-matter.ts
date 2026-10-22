'use client';

import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useAction, useMutation } from 'convex/react';
import { useState } from 'react';

/** The fictional sample matter: an acquisition with six synthetic agreements (demo-data/dist, served from /sample/). */
export const SAMPLE_MATTER = {
  name: 'Project Aster (sample)',
  number: 'SAMPLE-001',
  client: 'Brightwater Example Holdings Ltd',
  practiceArea: 'M&A',
  parties: [
    { name: 'Brightwater Example Holdings Ltd', role: 'client' },
    { name: 'Aster Example Systems Ltd', role: 'target' },
    { name: 'Quillon Analytics Inc.', role: 'counterparty' },
  ],
  files: ['msa-brightwater-quillon.pdf', 'saas-agreement-lattice.docx', 'office-lease-cedar-row.pdf', 'spa-excerpt-aster.pdf',
    'supply-agreement-meridian.pdf', 'dpa-lattice.docx'],
} as const;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain',
};

/** Creates the sample matter and uploads its documents through the same action the Vault uses. Returns the matter id. */
export function useAddSampleMatter() {
  const create = useMutation(api.matters.create);
  const upload = useAction(api.documents.upload);
  const [progress, setProgress] = useState<string | null>(null);

  async function add(firmId: Id<'firms'>): Promise<Id<'matters'>> {
    const { files, ...fields } = SAMPLE_MATTER;
    setProgress('Creating the matter…');
    const matterId = await create({ firmId, ...fields, parties: [...fields.parties], visibility: 'firm' });
    try {
      for (const [i, f] of files.entries()) {
        setProgress(`Adding documents ${i + 1} of ${files.length}…`);
        const res = await fetch(`/sample/${f}`);
        if (!res.ok) throw new Error(`${f}: ${res.status}`);
        await upload({ matterId, filename: f, bytes: await res.arrayBuffer(), contentType: MIME[f.split('.').pop()!]! });
      }
    } finally {
      setProgress(null);
    }
    return matterId;
  }

  return { add, progress };
}
