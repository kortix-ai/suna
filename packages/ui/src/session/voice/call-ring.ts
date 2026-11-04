'use client';

/**
 * What a caller hears until the call is answered: a ringback, two tones together (440 and 480 Hz, the North American
 * one) for 2 s, then 4 s of quiet, again until stopped. Generated here, no audio file; quiet (it is a cue, not the
 * call). Returns its stop. A browser without Web Audio rings silently.
 */
export function ringback(): () => void {
  const Ctx = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const tones = [440, 480].map((hz) => {
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    o.connect(gain);
    o.start();
    return o;
  });
  // Each 6 s cycle: on for 2 s (with 20 ms edges, so no click), off for 4 s. Scheduled a minute ahead, then again.
  let until = ctx.currentTime;
  const schedule = () => {
    const end = ctx.currentTime + 60;
    for (let t = Math.max(until, ctx.currentTime); t < end; t += 6) {
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(RING_GAIN, t + 0.02);
      gain.gain.setValueAtTime(RING_GAIN, t + 1.98);
      gain.gain.linearRampToValueAtTime(0, t + 2);
      until = t + 6;
    }
  };
  schedule();
  const timer = setInterval(schedule, 50_000);
  void ctx.resume().catch(() => {});
  return () => {
    clearInterval(timer);
    tones.forEach((o) => o.stop());
    void ctx.close().catch(() => {});
  };
}

/** The ringback's level: a cue under the page's own sounds. */
export const RING_GAIN = 0.05;

/** A call's length as a phone shows it: 0:07, 4:32, 1:02:09. */
export function callTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
