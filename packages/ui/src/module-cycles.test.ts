import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// No file-level import cycle crosses two top-level modules of src/. 2026-10-20:
// files/viewer re-exported FileViewer from session/panel, which imported files/viewer
// back, so './file-viewer' pulled 27 session files. Static, non-type imports only:
// a dynamic import() is lazy and breaks no load order.
const SRC = join(import.meta.dir);
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test-utils' || name === '__snapshots__' ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });

const files = walk(SRC);
const resolveFile = (from: string, spec: string) =>
  EXTS.map((ext) => join(dirname(from), spec) + ext)
    .concat(join(dirname(from), spec))
    .find((p) => /\.tsx?$/.test(p) && existsSync(p) && statSync(p).isFile());
const edges = new Map(
  files.map((file) => {
    const text = readFileSync(file, 'utf8').replace(/\bimport\s+type\b[^;]*;/g, '');
    const targets = [...text.matchAll(STATIC)].map((m) => resolveFile(file, m[1]!)).filter(Boolean) as string[];
    return [file, targets];
  }),
);
const moduleOf = (file: string) => relative(SRC, file).split('/')[0]!;

function stronglyConnected(): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      out.push(scc);
    }
  };
  for (const f of files) if (!idx.has(f)) visit(f);
  return out;
}

describe('module boundaries', () => {
  test('no import cycle spans two top-level modules', () => {
    const crossing = stronglyConnected()
      .filter((scc) => new Set(scc.map(moduleOf)).size > 1)
      .map((scc) => scc.map((f) => relative(SRC, f)).sort());
    expect(crossing).toEqual([]);
  });
});

// The README's layer table (## Layout): a file imports its own module or a lower
// layer. KNOWN_UPWARD lists the static upward imports that exist (2026-10-20,
// 26); move a file down or its dependency up and delete its line. It only shrinks.
const LAYER: Record<string, number> = {
  lib: 0,
  hooks: 0,
  icons: 0,
  providers: 0,
  i18n: 0,
  theme: 0,
  styles: 0,
  types: 0,
  primitives: 1,
  internal: 2,
  markdown: 3,
  diff: 3,
  changes: 4,
  files: 4,
  terminal: 4,
  apps: 4,
  browser: 4,
  access: 4,
  session: 5,
  customize: 6,
  workspace: 7,
};

const KNOWN_UPWARD: string[] = [
  'access/access/agent-principals.ts -> customize/sections/view/agent-editor-catalog.ts',
  'customize/connectors/connectors-page.tsx -> workspace/projects/policies-panel.tsx',
  'customize/sections/view/review-center-connected.tsx -> workspace/review/hooks/use-review-items.ts',
  'customize/sections/view/review-center-connected.tsx -> workspace/review/map.ts',
  'customize/sections/view/review-center-connected.tsx -> workspace/review/review-actions.ts',
  'customize/sections/view/review-center-connected.tsx -> workspace/review/review-center.tsx',
  'customize/settings/tabs/general-tab.tsx -> workspace/projects/modal/project-icon-field.tsx',
  'customize/settings/tabs/snapshots-tab.tsx -> workspace/sidebar/footer/sandbox-alert-state.ts',
  'customize/settings/tabs/snapshots-tab.tsx -> workspace/sidebar/footer/sandbox-health.ts',
  'customize/triggers/schedule-view.tsx -> workspace/projects/onboarding/app-logo.tsx',
  'customize/triggers/schedule/event-apps-strip.tsx -> workspace/projects/onboarding/app-logo.tsx',
  'customize/triggers/schedule/use-event-app-connect.ts -> workspace/projects/onboarding/connect-app.ts',
  'customize/triggers/schedule/when-event.tsx -> workspace/projects/onboarding/app-logo.tsx',
  'internal/auth/auth-consent.tsx -> markdown/copy-button.tsx',
  'internal/hooks/connectors/use-add-account.ts -> access/access/access-dialog-share.tsx',
  'internal/hooks/connectors/use-add-account.ts -> customize/connectors/install/install.ts',
  'internal/hooks/connectors/use-add-account.ts -> customize/connectors/provider-label.ts',
  'internal/hooks/connectors/use-add-account.ts -> customize/sections/connector-oauth2-start.ts',
  'internal/hooks/connectors/use-add-account.ts -> customize/sections/view/connector-connections.ts',
  'internal/hooks/connectors/use-add-managed-account.ts -> access/access/access-dialog-share.tsx',
  'internal/hooks/connectors/use-add-managed-account.ts -> customize/sections/view/connector-connections.ts',
  'internal/hooks/connectors/use-tool-connect.ts -> customize/sections/connector-connection-form.ts',
  'internal/hooks/projects/use-new-project-session.ts -> session/scope/create-scoped-session.ts',
  'internal/stores/session-filter-store.ts -> workspace/sidebar/session-grouping.ts',
  'internal/stores/settings-panel-store.ts -> customize/settings/settings-tabs.ts',
  'markdown/setup-links/approval-decision.tsx -> session/prompts/approval-request.tsx',
];

describe('module layers', () => {
  test('no file imports a higher layer outside KNOWN_UPWARD', () => {
    const upward: string[] = [];
    for (const [file, targets] of edges) {
      const from = LAYER[moduleOf(file)];
      for (const target of targets) {
        const to = LAYER[moduleOf(target)];
        if (from !== undefined && to !== undefined && to > from) {
          upward.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
        }
      }
    }
    expect([...new Set(upward)].sort()).toEqual(KNOWN_UPWARD);
  });
});
