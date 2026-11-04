import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CodePanel as SecurityPagePanel } from './security-page/code-panel';
import { CodePanel as SelfHostedPanel } from './self-hosted/code-panel';

// ─── Two marketing pages ship the same code panel in two copies that
// differ only in the React key of each row. These tests pin the rendering both
// must keep — comment/key/value in YAML, prompt/output in shell, blanks
// and repeated lines kept as rows — through both module paths, so the
// copies can collapse into one module without changing what a visitor sees.
// They pass unchanged before and after that dedupe. ────────────────────────

const YAML_LINES = [
  '# reads run; writes and destructive calls stop for a human',
  'policy:',
  '  default_mode: risk',
  '',
  'policies:',
  '  # a name-only rule cannot gate the target — conditions can',
  '  - match: gmail.send_email',
  '    action: require_approval',
] as const;

// The /self-hosted install snippet: two blank rows and repeated prompt rows.
const SHELL_LINES = [
  '# install the CLI',
  '$ curl -fsSL https://kortix.com/install | bash',
  '',
  '# create the config if it is missing, then start everything',
  '$ kortix self-host start',
  '→ stack up · dashboard registered as host "selfhost"',
  '',
  '# check on it any time',
  '$ kortix self-host status',
  '$ kortix self-host logs kortix-api',
] as const;

const COMMENT = 'text-muted-foreground/50';
const PROMPT = 'text-muted-foreground/35 select-none';
const OUTPUT = 'text-emerald-600 dark:text-emerald-400';
const KEY = 'text-foreground/85';
const VALUE = 'text-muted-foreground';
const ROW = '<span class="block whitespace-pre">';

// Panels keyed by their page, exactly as the pages import them.
const PANELS = [
  ['security-page', SecurityPagePanel],
  ['self-hosted', SelfHostedPanel],
] as const;

describe('the marketing code panel rendering, pinned for both pages', () => {
  test('renders a non-snippet line in the plain value color', () => {
    for (const [page, Panel] of PANELS) {
      const yaml = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="yaml" />);
      expect(yaml).toContain(`<span class="${VALUE}">plain text</span>`);
      const sh = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="sh" />);
      expect(sh).toContain(`<span class="${VALUE}">plain text</span>`);
    }
  });

  test('renders the identical markup from both module paths', () => {
    const rendered = PANELS.map(([, Panel]) => renderToStaticMarkup(<Panel title="t" lines={YAML_LINES} lang="yaml" />));
    expect(rendered[0]).toBe(rendered[1]);
  });

  test('appends the caller className to the panel frame', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(
        <Panel title="t" lines={YAML_LINES} lang="yaml" className="min-w-0" />,
      );
      expect(html).toContain('rounded-sm border min-w-0"');
    }
  });
});
