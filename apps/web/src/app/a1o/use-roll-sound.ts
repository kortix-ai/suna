'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Synthesized sound for the die. Everything is generated with Web Audio — no
 * asset files, no network, nothing to preload.
 *
 * - The AudioContext is built lazily, and only once navigator.userActivation
 *   reports a real gesture. Creating it earlier just earns an autoplay warning
 *   and a context stuck in `suspended`.
 * - Levels stay low. This is texture under a physics sim, not a notification.
 * - prefers-reduced-motion starts muted, since that visitor also gets a die
 *   that does not tumble.
 */

// Named to avoid "KEY": gitleaks' generic-api-key rule matches on a *_KEY
// identifier plus value entropy, and flagged this localStorage name as a
// credential.
const MUTE_PREFERENCE_ID = 'kortix.a1o.muted';

function prefersReducedMotion() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useRollSound() {
  const contextRef = useRef<AudioContext | null>(null);
  const busRef = useRef<GainNode | null>(null);
  const noiseRef = useRef<AudioBuffer | null>(null);
  // Read by the play helpers without rebuilding them on every toggle.
  const mutedRef = useRef(true);
  const [muted, setMuted] = useState(true);

  // Resolve the preference on the client only, so SSR and the first client
  // render agree (both start muted) and no hydration mismatch appears.
  useEffect(() => {
    let initial = prefersReducedMotion();
    try {
      const stored = window.localStorage.getItem(MUTE_PREFERENCE_ID);
      if (stored !== null) initial = stored === '1';
    } catch {
      // localStorage can throw in private modes — fall back to the media query.
    }
    mutedRef.current = initial;
    setMuted(initial);
  }, []);

  useEffect(() => {
    return () => {
      void contextRef.current?.close();
      contextRef.current = null;
      busRef.current = null;
    };
  }, []);

  const ensureContext = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const activation = navigator.userActivation;
    if (activation && !activation.hasBeenActive && !contextRef.current) {
      return null;
    }
    if (!contextRef.current) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      const context = new Ctor();
      const bus = context.createGain();
      bus.gain.value = 1;
      bus.connect(context.destination);

      // One second of white noise, reused for every clack.
      const buffer = context.createBuffer(
        1,
        context.sampleRate,
        context.sampleRate,
      );
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

      contextRef.current = context;
      busRef.current = bus;
      noiseRef.current = buffer;
    }
    if (contextRef.current.state === 'suspended') {
      void contextRef.current.resume();
    }
    return contextRef.current;
  }, []);

  /** Filtered noise burst — the die hitting the table. */
  const playImpact = useCallback(
    (strength: number) => {
      if (mutedRef.current) return;
      const context = ensureContext();
      const bus = busRef.current;
      const noise = noiseRef.current;
      if (!context || !bus || !noise) return;

      const now = context.currentTime;
      const clamped = Math.max(0.05, Math.min(strength, 1));

      const source = context.createBufferSource();
      source.buffer = noise;

      // Harder hits ring brighter, the way a real die does on a hard surface.
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(900 + clamped * 2200, now);
      filter.Q.setValueAtTime(1.1, now);

      const duration = 0.05 + clamped * 0.05;
      const env = context.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(0.16 * clamped, now + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      source.connect(filter).connect(env).connect(bus);
      source.start(now);
      source.stop(now + duration + 0.02);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        env.disconnect();
      };
    },
    [ensureContext],
  );

  /** Airy sweep as the die leaves the hand. */
  const playThrow = useCallback(() => {
    if (mutedRef.current) return;
    const context = ensureContext();
    const bus = busRef.current;
    const noise = noiseRef.current;
    if (!context || !bus || !noise) return;

    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(420, now);
    filter.frequency.exponentialRampToValueAtTime(1500, now + 0.26);
    filter.Q.setValueAtTime(0.8, now);

    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    source.connect(filter).connect(env).connect(bus);
    source.start(now);
    source.stop(now + 0.33);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      env.disconnect();
    };
  }, [ensureContext]);

  /** Soft confirmation once the die has come to rest. */
  const playSettle = useCallback(() => {
    if (mutedRef.current) return;
    const context = ensureContext();
    const bus = busRef.current;
    if (!context || !bus) return;

    const now = context.currentTime;
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(392, now);
    osc.frequency.exponentialRampToValueAtTime(587, now + 0.16);

    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);

    osc.connect(env).connect(bus);
    osc.start(now);
    osc.stop(now + 0.36);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  }, [ensureContext]);

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    try {
      window.localStorage.setItem(MUTE_PREFERENCE_ID, next ? '1' : '0');
    } catch {
      // Non-fatal: the preference just will not survive a reload.
    }
    if (!next) {
      ensureContext();
      // Defer past the state flush so the helper sees the unmuted ref.
      requestAnimationFrame(() => playSettle());
    }
  }, [ensureContext, playSettle]);

  return { muted, toggleMuted, playThrow, playImpact, playSettle };
}
