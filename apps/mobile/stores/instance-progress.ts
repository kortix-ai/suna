import { useState, useEffect } from 'react';

export type InstanceProgress = { percent: number; message: string } | null;

let _progress: InstanceProgress = null;
const _listeners = new Set<(p: InstanceProgress) => void>();

export function setInstanceProgress(p: InstanceProgress) {
  _progress = p;
  _listeners.forEach((fn) => fn(p));
}

export function getInstanceProgress(): InstanceProgress {
  return _progress;
}

export function useInstanceProgress(): InstanceProgress {
  const [progress, setProgress] = useState<InstanceProgress>(_progress);
  useEffect(() => {
    const handler = (p: InstanceProgress) => setProgress(p);
    _listeners.add(handler);
    setProgress(_progress);
    return () => { _listeners.delete(handler); };
  }, []);
  return progress;
}
