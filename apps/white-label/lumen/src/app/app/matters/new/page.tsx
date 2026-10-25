'use client';

import { MattersList } from '@/components/matters/matters-list';

/** The new-matter dialog over the list (the command palette and links land here). */
export default function NewMatterPage() {
  return <MattersList startOpen />;
}
