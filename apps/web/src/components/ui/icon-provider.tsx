'use client';

import { IconContext, type IconWeight } from '@phosphor-icons/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  DEFAULT_ICON_WEIGHT,
  ICON_WEIGHT_STORAGE_KEY,
  ICON_WEIGHTS,
} from '@/lib/icons/icon-config';

interface IconWeightControl {
  weight: IconWeight;
  setWeight: (weight: IconWeight) => void;
}

const IconWeightContext = createContext<IconWeightControl | null>(null);

export function useIconWeight(): IconWeightControl {
  const ctx = useContext(IconWeightContext);
  if (!ctx) throw new Error('useIconWeight must be used within IconProvider');
  return ctx;
}

export function IconProvider({ children }: { children: React.ReactNode }) {
  const [weight, setWeightState] = useState<IconWeight>(DEFAULT_ICON_WEIGHT);

  /* Dev-only live override; applied post-mount so SSR markup always matches
     DEFAULT_ICON_WEIGHT and hydration never mismatches. */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const stored = window.localStorage.getItem(
      ICON_WEIGHT_STORAGE_KEY,
    ) as IconWeight | null;
    if (stored && ICON_WEIGHTS.includes(stored)) setWeightState(stored);
  }, []);

  const setWeight = useCallback((next: IconWeight) => {
    setWeightState(next);
    if (process.env.NODE_ENV === 'development') {
      window.localStorage.setItem(ICON_WEIGHT_STORAGE_KEY, next);
    }
  }, []);

  const control = useMemo(() => ({ weight, setWeight }), [weight, setWeight]);
  /* size 24 replicates lucide's default so class-less icons keep their size;
     Tailwind size classes and explicit size props both still win. */
  const iconDefaults = useMemo(() => ({ weight, size: 24 }), [weight]);

  return (
    <IconWeightContext.Provider value={control}>
      <IconContext.Provider value={iconDefaults}>{children}</IconContext.Provider>
    </IconWeightContext.Provider>
  );
}
