import { useState, useRef, useCallback, useMemo } from "react";
import type { ChunkMessage, StreamStatus } from "@agentpress/shared";

export interface UseStreamStateResult {
  status: StreamStatus;
  setStatus: (status: StreamStatus) => void;
  orderedContent: string;
  error: string | null;
  setError: (error: string | null) => void;
  appendChunk: (chunk: ChunkMessage) => void;
  reset: () => void;
}

export function useStreamState(): UseStreamStateResult {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [chunks, setChunks] = useState<ChunkMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  const pendingRef = useRef<ChunkMessage[]>([]);
  const rafRef = useRef<number | null>(null);
  
  const flush = useCallback(() => {
    if (pendingRef.current.length > 0) {
      const pending = pendingRef.current;
      pendingRef.current = [];
      setChunks(prev => {
        const combined = [...prev, ...pending];
        const deduplicated = new Map<number, ChunkMessage>();
        for (const chunk of combined) {
          const seq = chunk.sequence ?? 0;
          if (!deduplicated.has(seq) || (deduplicated.get(seq)?.sequence ?? 0) < seq) {
            deduplicated.set(seq, chunk);
          }
        }
        return Array.from(deduplicated.values()).sort((a, b) => 
          (a.sequence ?? 0) - (b.sequence ?? 0)
        );
      });
    }
    rafRef.current = null;
  }, []);
  
  const appendChunk = useCallback((chunk: ChunkMessage) => {
    pendingRef.current.push(chunk);
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);
  
  const orderedContent = useMemo(() => 
    chunks.map(c => c.content).join(""), 
    [chunks]
  );
  
  const reset = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = [];
    setChunks([]);
    setStatus("idle");
    setError(null);
  }, []);
  
  return { status, setStatus, orderedContent, error, setError, appendChunk, reset };
}
