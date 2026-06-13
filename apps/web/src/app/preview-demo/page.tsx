'use client';

import { useEffect, useState } from 'react';

// Full-stack preview demo: this page calls whatever backend NEXT_PUBLIC_BACKEND_URL
// points at and shows it. On a per-PR Vercel preview the wiring sets that to
// https://pr-<n>.preview-api.kortix.com/v1, so this should report
// environment="preview", version="pr-<sha>", demo_marker="fullstack-preview-demo"
// — proving the preview frontend talks to its OWN preview backend.

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export default function PreviewDemoPage() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = `${BACKEND.replace(/\/$/, '')}/health`;
    fetch(url)
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: '64px auto', padding: 24, fontFamily: 'ui-monospace, monospace' }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Full-stack preview demo</h1>
      <p style={{ opacity: 0.7, marginBottom: 24 }}>
        This frontend is calling backend: <strong>{BACKEND || '(NEXT_PUBLIC_BACKEND_URL unset)'}</strong>
      </p>

      {error && <pre style={{ color: '#c00' }}>error: {error}</pre>}

      {health ? (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {(['environment', 'version', 'demo_marker', 'commit', 'memory_mb', 'instance', 'status'] as const).map((k) => (
              <tr key={k}>
                <td style={{ padding: '6px 12px', opacity: 0.6, borderBottom: '1px solid #eee' }}>{k}</td>
                <td style={{ padding: '6px 12px', borderBottom: '1px solid #eee' }}>
                  <strong>{String(health[k] ?? '—')}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !error && <p>loading…</p>
      )}
    </main>
  );
}
