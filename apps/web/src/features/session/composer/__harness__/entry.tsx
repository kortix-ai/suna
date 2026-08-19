/**
 * Browser harness — NOT shipped, NOT imported by the app.
 *
 * Mounts the REAL `ComposerEditor` (production code, unmodified) in a real
 * browser so the `@` / `/` menus can be observed opening, positioning and
 * selecting. The repo's `bun test` has no DOM, so every menu assertion until
 * now was made against pure functions with the mount path unproven.
 *
 * Build:  bun build entry.tsx --outfile harness.js
 * Serve:  any static server; drive with Playwright.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';

import { ComposerEditor, type ComposerEditorHandle } from '../editor/composer-editor';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const AGENTS = [
  { name: 'build', description: 'Default build agent' },
  { name: 'plan', description: 'Planning agent' },
  { name: 'reviewer', description: 'Reviews diffs' },
] as never[];

const SESSIONS = [
  {
    id: 'ses_abc',
    title: 'Fix the auth redirect',
    time: { updated: Date.now() - 3_600_000, archived: undefined },
    summary: { files: 4, diffs: [{ file: 'src/auth.ts' }] },
  },
] as never[];

const COMMANDS = [
  { name: 'company-initiation-report', description: 'Create an initiation report', source: 'skill' },
  { name: 'finance-screener-workflow-fast', description: 'Screen finances fast', source: 'skill' },
  { name: 'deploy', description: 'Deploy the current branch', source: 'command' },
] as never[];

declare global {
  interface Window {
    __log: string[];
    __rerender: () => void;
    __stateLog: boolean;
    __handle: () => ComposerEditorHandle | null;
  }
}
window.__log = [];
window.__stateLog = new URLSearchParams(location.search).get('state') === '1';

function Harness() {
  const ref = useRef<ComposerEditorHandle | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [, force] = useState(0);

  // Assigned in an effect, not during render: writing to `window` in the
  // render body is a side effect, which `react-hooks/set-state-in-effect`'s
  // sibling rules flag and which would run twice under StrictMode.
  useEffect(() => {
    window.__rerender = () => force((n) => n + 1);
    window.__handle = () => ref.current;
  }, []);

  const push = (line: string) => {
    window.__log.push(line);
    // Only round-trip through React state when ?state=1 — this is the switch
    // that isolates "does a parent re-render tear the menu down".
    if (window.__stateLog) setLog((l) => [...l, line]);
  };

  // Mirrors the real session shell: full-height flex column, scrolling
  // transcript, composer pinned at the bottom. `?bottom=1` turns it on — the
  // menu's floating position is measured from the caret, so where the caret
  // sits on screen is the whole variable this reproduces.
  const bottom = new URLSearchParams(location.search).get('bottom') === '1';

  if (bottom) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {Array.from({ length: 40 }, (_, i) => (
            <p key={i} className="text-muted-foreground py-2 text-sm">
              Transcript line {i + 1}
            </p>
          ))}
        </div>
        <div className="shrink-0 px-6 pb-6">
          <div className="mx-auto w-full max-w-3xl">
            {/* The `/` menu's dock — mirrors `composer.tsx`'s, above the card
                and unstyled, so `?bottom=1` reproduces the real docked layout
                (composer pinned to the bottom, palette stacked on top of it)
                rather than only the floating `@` case. */}
            <div id="slash-dock" />
            <div id="composer-shell" className="bg-popover w-full rounded-2xl border p-3">
              <ComposerEditor
                ref={ref}
                placeholder="Type a command..."
                onSubmit={() => push('submit')}
                onEmptyChange={(empty) => push(`empty:${empty}`)}
                agents={AGENTS}
                sessions={SESSIONS}
                currentSessionId="ses_current"
                commands={COMMANDS}
                slashDockSelector="#slash-dock"
                onSelectCommand={(c) => push(`command:${c.name}`)}
                onSelectAction={(a) => push(`action:${a.id}`)}
                onMenuOpenChange={(open) => push(`menu:${open}`)}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <div id="slash-dock" />
      <div id="composer-shell">
        <ComposerEditor
          ref={ref}
          placeholder="Type a command..."
          onSubmit={() => push('submit')}
          onEmptyChange={(empty) => push(`empty:${empty}`)}
          agents={AGENTS}
          sessions={SESSIONS}
          currentSessionId="ses_current"
          commands={COMMANDS}
          slashDockSelector="#slash-dock"
          onSelectCommand={(c) => push(`command:${c.name}`)}
          onSelectAction={(a) => push(`action:${a.id}`)}
          onMenuOpenChange={(open) => push(`menu:${open}`)}
        />
      </div>
      <pre id="harness-log">{log.join('\n')}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);
