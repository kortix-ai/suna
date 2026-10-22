import { useCallback, useEffect, useRef, useState } from 'react';
import { searchFiles, rankFile } from '@/lib/utils/file-search';

function rankedCache(files: Set<string>, q: string): string[] {
  return Array.from(files)
    .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
    .sort((a, b) => rankFile(a, q) - rankFile(b, q));
}

export function useMentionFileSearch(mentionQuery: { query: string } | null, sandboxUrl?: string) {
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileSearchSeq = useRef(0);
  const fileResultsCache = useRef<Set<string>>(new Set());

  // ── Debounced file search (matches frontend useEffect) ──────────────────
  useEffect(() => {
    clearTimeout(fileSearchTimer.current);

    if (!mentionQuery || !sandboxUrl) {
      setFileResults([]);
      setFileSearchLoading(false);
      fileResultsCache.current.clear();
      return;
    }

    // Immediately apply cached results that match the new query
    const q = mentionQuery.query.toLowerCase();
    if (fileResultsCache.current.size > 0) {
      const cachedMatches = rankedCache(fileResultsCache.current, q);
      if (cachedMatches.length > 0) {
        setFileResults(cachedMatches.slice(0, 20));
      }
    }

    setFileSearchLoading(true);
    const seq = ++fileSearchSeq.current;
    const currentQuery = mentionQuery.query;

    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await searchFiles(sandboxUrl, currentQuery);
        for (const r of results) fileResultsCache.current.add(r);
        if (seq === fileSearchSeq.current) {
          const ql = currentQuery.toLowerCase();
          const cachedMatches = rankedCache(fileResultsCache.current, ql);
          const merged = new Set([...results, ...cachedMatches]);
          setFileResults(rankedCache(merged, ql).slice(0, 20));
          setFileSearchLoading(false);
        }
      } catch {
        if (seq === fileSearchSeq.current) {
          const ql = currentQuery.toLowerCase();
          const cachedMatches = rankedCache(fileResultsCache.current, ql);
          setFileResults(cachedMatches.slice(0, 20));
          setFileSearchLoading(false);
        }
      }
    }, 150);

    return () => clearTimeout(fileSearchTimer.current);
  }, [mentionQuery?.query, sandboxUrl]);

  const clear = useCallback(() => {
    setFileResults([]);
    fileResultsCache.current.clear();
  }, []);

  return { results: fileResults, loading: fileSearchLoading, clear };
}
