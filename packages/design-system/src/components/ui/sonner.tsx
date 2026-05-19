'use client';

import 'sileo/styles.css';

import type { ComponentProps, ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { sileo, Toaster as SileoToaster, type SileoOptions } from 'sileo';

type ToastInput = string | ReactNode;

interface ToastOptions {
  description?: ReactNode;
  duration?: number;
  id?: string;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
}

function build(input: ToastInput, opts?: ToastOptions): SileoOptions {
  const title = typeof input === 'string' ? input : undefined;
  const description = typeof input === 'string' ? opts?.description : (input as ReactNode);
  return {
    title,
    description,
    duration: opts?.duration,
    icon: opts?.icon,
    button: opts?.action ? { title: opts.action.label, onClick: opts.action.onClick } : undefined,
  };
}

export const toast = Object.assign(
  (input: ToastInput, opts?: ToastOptions) => sileo.show(build(input, opts)),
  {
    success: (input: ToastInput, opts?: ToastOptions) => sileo.success(build(input, opts)),
    error: (input: ToastInput, opts?: ToastOptions) => sileo.error(build(input, opts)),
    warning: (input: ToastInput, opts?: ToastOptions) => sileo.warning(build(input, opts)),
    info: (input: ToastInput, opts?: ToastOptions) => sileo.info(build(input, opts)),
    loading: (input: ToastInput, opts?: ToastOptions) =>
      sileo.show({ ...build(input, opts), type: 'loading' }),
    dismiss: (id?: string) => (id ? sileo.dismiss(id) : sileo.clear()),
    promise: sileo.promise,
  },
);

type ToasterProps = Pick<ComponentProps<typeof SileoToaster>, 'position' | 'offset'>;

export function Toaster({ position = 'bottom-right', offset }: ToasterProps = {}) {
  const { theme = 'system' } = useTheme();
  return (
    <SileoToaster
      position={position}
      offset={offset ?? { bottom: '1.25rem', right: '1.25rem' }}
      theme={theme as 'light' | 'dark' | 'system'}
      options={{
        roundness: 14,
        autopilot: { expand: 90, collapse: 140 },
        styles: {
          title: 'tracking-tight!',
          description: 'opacity-75!',
        },
      }}
    />
  );
}

export { sileo };
