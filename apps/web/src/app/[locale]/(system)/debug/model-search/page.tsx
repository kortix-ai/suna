'use client';

import { useState } from 'react';
import { ModelSearchEmpty } from '@kortix/ui/session/models/model-search-empty';

/** KRTX-1863: deterministic picker states, without a paid inference account. */
export default function ModelSearchDebugPage() {
  const [action, setAction] = useState('No action yet');
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-10">
      <h1 className="text-xl">Model search states — KRTX-1863</h1>
      <p className="text-muted-foreground text-sm">
        PASS: one model explains project scope; ordinary misses keep search guidance. These are
        fixtures, not a live account.
      </p>
      <h2>One model, billing enabled</h2>
      <ModelSearchEmpty
        search="claude"
        modelCount={1}
        onClear={() => setAction('Search cleared')}
        onUpgrade={() => setAction('Upgrade requested')}
      />
      <h2>One model, billing disabled</h2>
      <ModelSearchEmpty
        search="claude"
        modelCount={1}
        onClear={() => setAction('Search cleared')}
      />
      <h2>Multiple models — original ordinary-miss state</h2>
      <ModelSearchEmpty
        search="claude"
        modelCount={12}
        onClear={() => setAction('Search cleared')}
      />
      <p role="status">{action}</p>
    </main>
  );
}
