'use client';

import * as React from 'react';

import { PortalContainerProvider } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { type KortixTheme, themeToCss } from './theme';

export interface ThemeScopeProps extends React.HTMLAttributes<HTMLDivElement> {
  theme: KortixTheme;
}

/**
 * Applies a theme to its subtree only. Overlays opened inside it (dialogs,
 * popovers, menus, tooltips, selects, sheets, drawers) portal into the scope,
 * so they paint its tokens too. Light and dark follow `.dark` on <html>; put
 * `className="dark"` on the scope to force dark for the subtree.
 *
 * The scope element sets font-family and color, because both are inherited
 * from <html>/<body> as computed values and would otherwise ignore the
 * override. It paints no background: add `bg-background` when it should.
 */
export function ThemeScope({ theme, className, children, ...props }: ThemeScopeProps) {
  const id = React.useId();
  const [portalHost, setPortalHost] = React.useState<HTMLDivElement | null>(null);
  const css = React.useMemo(() => themeToCss(theme, `[data-kortix-theme="${id}"]`), [theme, id]);
  return (
    <div data-kortix-theme={id} className={cn('text-foreground font-sans', className)} {...props}>
      <style>{css}</style>
      <PortalContainerProvider value={portalHost}>
        {children}
        <div data-kortix-portal-host="" ref={setPortalHost} />
      </PortalContainerProvider>
    </div>
  );
}
