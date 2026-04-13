'use client';

import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { createClient } from '@/lib/supabase/client';

const SLEEP_KEY = 'kortix-sleep-active-v1';

const listeners = new Set<() => void>();

function getSleeping() {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SLEEP_KEY) === 'true';
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify() {
  listeners.forEach((cb) => cb());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SLEEP_KEY) listeners.forEach((cb) => cb());
  });
}

export function useSleep() {
  const sleeping = useSyncExternalStore(subscribe, getSleeping, () => false);

  const sleep = useCallback(() => {
    localStorage.setItem(SLEEP_KEY, 'true');
    notify();
  }, []);

  const wake = useCallback(() => {
    localStorage.removeItem(SLEEP_KEY);
    notify();
  }, []);

  return { sleeping, sleep, wake };
}

function SleepClock({ phase }: { phase: 'in' | 'visible' | 'out' }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);
  const day = now?.toLocaleDateString('en-US', { weekday: 'short' }) ?? '---';
  const month = now?.toLocaleDateString('en-US', { month: 'short' }) ?? '---';
  const date = now?.getDate() ?? '--';
  const h = now ? now.getHours() % 12 || 12 : '--';
  const m = now ? now.getMinutes().toString().padStart(2, '0') : '--';

  return (
    <div
      className="flex flex-col items-center"
      style={{
        opacity: phase === 'visible' ? 1 : 0,
        transform: phase === 'in' ? 'scale(1.08) translateY(-10px)' : phase === 'out' ? 'scale(0.96) translateY(8px)' : 'scale(1) translateY(0)',
        transition: 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <p className="text-foreground/35 text-[13px] font-light tracking-widest" suppressHydrationWarning>
        {day} {month} {date}
      </p>
      <p
        className="text-foreground/80 text-[80px] sm:text-[104px] font-extralight leading-none -tracking-[0.02em] tabular-nums"
        suppressHydrationWarning
      >
        {h}:{m}
      </p>
    </div>
  );
}

function useSleepUser() {
  const [user, setUser] = useState<{ name: string; avatar: string } | null>(null);
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUser({
          name: data.user.user_metadata?.name || data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || 'User',
          avatar: data.user.user_metadata?.avatar_url || data.user.user_metadata?.picture || '',
        });
      }
    });
  }, []);
  return user;
}

export function SleepOverlay() {
  const { sleeping, wake } = useSleep();
  const user = useSleepUser();
  const [stage, setStage] = useState<'mounting' | 'in' | 'visible' | 'out' | 'hidden'>('hidden');
  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  useEffect(() => {
    if (sleeping && (stage === 'hidden' || stage === 'mounting')) {
      setStage('mounting');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setStage('in');
          setTimeout(() => setStage('visible'), 800);
        });
      });
    }
  }, [sleeping, stage]);

  const handleWake = useCallback(() => {
    if (stage !== 'visible' && stage !== 'in') return;
    setStage('out');
    setTimeout(() => {
      wakeRef.current();
      setStage('hidden');
    }, 700);
  }, [stage]);

  useEffect(() => {
    if (stage !== 'visible' && stage !== 'in') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleWake();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, handleWake]);

  if (stage === 'hidden') return null;

  const isAnimatedIn = stage === 'in' || stage === 'visible';
  const isOut = stage === 'out';

  return (
    <div
      className="fixed inset-0 z-[9999] select-none cursor-pointer bg-background"
      onClick={handleWake}
      style={{
        opacity: isOut ? 0 : isAnimatedIn ? 1 : 0,
        transition: isOut
          ? 'opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1)'
          : 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          filter: isAnimatedIn ? 'blur(0px)' : isOut ? 'blur(30px)' : 'blur(30px)',
          transform: isAnimatedIn ? 'scale(1)' : isOut ? 'scale(1.1)' : 'scale(1.1)',
          opacity: isAnimatedIn ? 1 : isOut ? 0 : 0,
          transition: isOut
            ? 'filter 0.7s cubic-bezier(0.16, 1, 0.3, 1), transform 0.7s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1)'
            : 'filter 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <WallpaperBackground />
      </div>
      <div className="relative z-10 flex justify-center pt-[12vh] sm:pt-[14vh]">
        <SleepClock phase={isAnimatedIn ? 'visible' : isOut ? 'out' : 'in'} />
      </div>
      <div
        className="absolute z-10 bottom-[8vh] sm:bottom-[10vh] left-0 right-0 flex flex-col items-center"
        style={{
          opacity: isAnimatedIn ? 1 : 0,
          transform: isAnimatedIn ? 'translateY(0)' : isOut ? 'translateY(12px)' : 'translateY(12px)',
          transition: isOut
            ? 'opacity 0.4s ease, transform 0.4s ease'
            : 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.3s, transform 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.3s',
        }}
      >
        <div className="w-16 h-16 sm:w-[72px] sm:h-[72px] rounded-full flex items-center justify-center mb-2.5 bg-foreground/[0.04] border border-foreground/[0.06] overflow-hidden">
          {user?.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-foreground/40 text-xl font-medium">
              {user?.name?.charAt(0)?.toUpperCase() || ''}
            </span>
          )}
        </div>
        <p className="text-foreground/80 text-[15px] sm:text-base font-medium tracking-wide mb-1">
          {user?.name || ''}
        </p>
        <p className="text-foreground/30 text-xs tracking-wide">
          Click anywhere or press Enter to continue
        </p>
      </div>
    </div>
  );
}
