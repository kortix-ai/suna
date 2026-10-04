import { runTmpReaperSweep } from '../services/snapshots/tmp-reaper';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startTmpReaper(): void {
  if (timer) return;
  void runTmpReaperSweep();
  timer = setInterval(() => void runTmpReaperSweep(), SWEEP_INTERVAL_MS);
  // Don't keep the process alive for the reaper.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopTmpReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
