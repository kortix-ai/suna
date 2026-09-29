import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SidebarContext,
  SidebarProvider,
  type SidebarToggleOptions,
  useOptionalSidebar,
  useSidebar,
} from './sidebar';

/**
 * Characterization of the sidebar context kernel as it is read through the
 * public `./sidebar` module: the boundary semantics of `useSidebar` /
 * `useOptionalSidebar` and the identity of the re-exported `SidebarContext`.
 * Phase 1 of the sidebar split moves the kernel to `sidebar-context.tsx` and
 * re-exports it here; this file passes unchanged before and after that move.
 */
function StateProbe() {
  const { state } = useSidebar();
  return <span data-state={state} />;
}

function OptionalStateProbe() {
  const context = useOptionalSidebar();
  return <span data-state={context ? context.state : 'none'} />;
}

function ContextIdentityProbe() {
  const fromHook = useSidebar().state;
  const fromContext = React.useContext(SidebarContext)?.state;
  return <span data-hook={fromHook} data-context={fromContext} />;
}

describe('Sidebar context kernel', () => {
  test('useSidebar throws outside a SidebarProvider', () => {
    expect(() => renderToStaticMarkup(<StateProbe />)).toThrow(
      'useSidebar must be used within a SidebarProvider.',
    );
  });

  test('useOptionalSidebar returns null outside a SidebarProvider', () => {
    expect(renderToStaticMarkup(<OptionalStateProbe />)).toContain('data-state="none"');
  });

  test('useSidebar reads the provider state', () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(html).toContain('data-state="collapsed"');
  });

  test('SidebarContext is the context the provider supplies', () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <ContextIdentityProbe />
      </SidebarProvider>,
    );
    // `useContext(SidebarContext)` sees the value `useSidebar` reads. A
    // re-export pointing at a second context would render no value here.
    expect(html).toContain('data-hook="collapsed"');
    expect(html).toContain('data-context="collapsed"');
  });

  test('SidebarToggleOptions stays exported', () => {
    const options: SidebarToggleOptions = { instant: true };
    expect(options.instant).toBe(true);
  });
});
