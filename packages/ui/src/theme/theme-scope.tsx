'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

import { PortalContainerProvider } from '../lib/portal-container';
import { cn } from '../lib/utils';
import { type KortixTheme, themeToCss } from './theme';

export interface ThemeScopeProps extends React.HTMLAttributes<HTMLDivElement> {
  theme: KortixTheme;
}

/** The enclosing scopes, so a nested scope's overlay host also carries the outer themes. */
const ScopeContext = React.createContext<{ ids: string; dark: boolean } | null>(null);

/**
 * Applies a theme to its subtree only. Light and dark follow `.dark` on
 * <html>; put `className="dark"` on the scope to force dark for the subtree.
 *
 * Overlays opened inside it (dialogs, popovers, menus, tooltips, selects,
 * sheets, drawers) portal into a themed host at the end of <body>, so they
 * paint the scope's tokens and are never clipped or offset by a transformed,
 * filtered or overflow-hidden ancestor of the scope.
 *
 * The scope element holds only `children`: its stylesheet is a hidden
 * sibling rendered just before it, and the overlay host lives in <body>, so
 * `flex gap-*`, `grid`, `space-y-*` and `first:`/`last:` on the scope's
 * children behave as they would without it.
 *
 * The scope element sets font-family and color, because both are inherited
 * from <html>/<body> as computed values and would otherwise ignore the
 * override. It paints no background: add `bg-background` when it should.
 */
export function ThemeScope({ theme, className, children, ...props }: ThemeScopeProps) {
  const id = React.useId();
  const parent = React.useContext(ScopeContext);
  const dark = /(^|\s)dark(\s|$)/.test(className ?? '') || (parent?.dark ?? false);
  const scope = React.useMemo(() => ({ ids: parent ? `${parent.ids} ${id}` : id, dark }), [parent, id, dark]);
  const css = React.useMemo(() => themeToCss(theme, `[data-kortix-theme~="${id}"]`), [theme, id]);
  const [portalHost, setPortalHost] = React.useState<HTMLDivElement | null>(null);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return (
    <ScopeContext.Provider value={scope}>
      {/* themeToCss rejects any value that could end a rule, so raw text is safe; React 18 would entity-escape quotes in a text child. */}
      <style data-kortix-theme-style="" dangerouslySetInnerHTML={{ __html: css }} />
      <div data-kortix-theme={id} className={cn('text-foreground font-sans', className)} {...props}>
        <PortalContainerProvider value={portalHost}>{children}</PortalContainerProvider>
      </div>
      {mounted &&
        createPortal(
          <div
            data-kortix-theme={scope.ids}
            data-kortix-portal-host=""
            className={cn(dark && 'dark', 'text-foreground font-sans')}
            ref={setPortalHost}
          />,
          document.body,
        )}
    </ScopeContext.Provider>
  );
}
