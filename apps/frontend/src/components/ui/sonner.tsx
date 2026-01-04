'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': '1rem',
          'fontFamily': 'var(--font-geist-sans), ui-sans-serif, -apple-system, system-ui, sans-serif',

        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
