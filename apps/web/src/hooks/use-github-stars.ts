'use client';

import { useEffect, useState } from 'react';

/**
 * The live star count on `kortix-ai/CompanyOS`, read from `/api/github-stars`.
 *
 * The navbar reads this hook. The module-level in-flight promise shares one
 * request across mounts and client-side route changes.
 *
 * NEVER SUBSTITUTE A NUMBER. This used to fall back to a hardcoded `20000` when
 * the route failed, so an outage printed an invented figure under the caption
 * "GitHub stars on kortix-ai/CompanyOS" — at 72px on the home page. A failure now
 * resolves to `null` and every caller renders its own honest placeholder.
 *
 * The `owner` / `repo` arguments are vestigial: the route is hardcoded to
 * `kortix-ai/CompanyOS` server-side. They are kept so existing call sites compile.
 */
let inFlight: Promise<number | null> | null = null;

/** Exported for `use-github-stars.test.ts`; call the hook, not this. */
export function fetchGitHubStars(): Promise<number | null> {
  inFlight ??= fetch('/api/github-stars')
    .then((res) => {
      if (!res.ok) throw new Error(`github-stars ${res.status}`);
      return res.json();
    })
    .then((data: { stars?: unknown }) =>
      typeof data.stars === 'number' && Number.isFinite(data.stars) ? data.stars : null,
    )
    .catch(() => {
      /* Drop the rejected promise so a later mount can retry rather than
         inheriting this failure for the life of the tab. */
      inFlight = null;
      return null;
    });

  return inFlight;
}

export function useGitHubStars(_owner?: string, _repo?: string) {
  const [stars, setStars] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    fetchGitHubStars().then((value) => {
      if (!active) return;
      setStars(value);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

  const formatStars = (count: number | null): string => {
    if (count === null) return '–';
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return count.toString();
  };

  return {
    stars,
    formattedStars: formatStars(stars),
    loading,
  };
}
