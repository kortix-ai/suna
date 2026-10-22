import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CodePanel as AgentComputerPanel } from './agent-computer/code-panel';
import { CodePanel as SecurityPagePanel } from './security-page/code-panel';
import { CodePanel as SelfHostedPanel } from './self-hosted/code-panel';

// ─── Three marketing pages ship the same code panel in three copies that
// differ only in the React key of each row. These tests pin the rendering all
// three must keep — comment/key/value in YAML, prompt/output in shell, blanks
// and repeated lines kept as rows — through all three module paths, so the
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
  ['agent-computer', AgentComputerPanel],
  ['security-page', SecurityPagePanel],
  ['self-hosted', SelfHostedPanel],
] as const;

describe('the marketing code panel rendering, pinned for all three pages', () => {
  test('colors YAML comments, keys, indents and values', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(<Panel title="kortix.yaml" lines={YAML_LINES} lang="yaml" />);
      expect(html.startsWith(
        '<div class="border-border bg-card flex h-full flex-col rounded-sm border">' +
          '<div class="border-border flex items-center gap-3 border-b px-4 py-3">' +
          '<span class="text-muted-foreground font-mono text-xs">kortix.yaml</span></div>',
      )).toBe(true);
      // A comment line renders whole, in the comment color.
      expect(html).toContain(
        `<span class="${COMMENT}"># reads run; writes and destructive calls stop for a human</span>`,
      );
      // An indented comment keeps its indent in the comment color.
      expect(html).toContain(
        `<span class="${COMMENT}">  # a name-only rule cannot gate the target — conditions can</span>`,
      );
      // Key and value split around the colon; the indent rides the comment color.
      expect(html).toContain(
        `<span class="${COMMENT}">  </span><span class="${KEY}">default_mode</span>` +
          `<span class="${COMMENT}">:</span><span class="${VALUE}"> risk</span>`,
      );
      // A list item keeps `- ` in the indent span, then the key/value split.
      expect(html).toContain(
        `<span class="${COMMENT}">  - </span><span class="${KEY}">match</span>` +
          `<span class="${COMMENT}">:</span><span class="${VALUE}"> gmail.send_email</span>`,
      );
      // A nested block keeps its four-space indent.
      expect(html).toContain(
        `<span class="${COMMENT}">    </span><span class="${KEY}">action</span>` +
          `<span class="${COMMENT}">:</span><span class="${VALUE}"> require_approval</span>`,
      );
      // A bare key with no value still splits around the colon.
      expect(html).toContain(`<span class="${KEY}">policy</span><span class="${COMMENT}">:</span><span class="${VALUE}"></span>`);
    }
  });

  test('colors shell prompts, output and comments', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(<Panel title="bring the stack up" lines={SHELL_LINES} lang="sh" />);
      expect(html).toContain(`<span class="${COMMENT}"># install the CLI</span>`);
      // The prompt is its own unselectable span; the command follows verbatim.
      expect(html).toContain(
        `<span class="${PROMPT}">$</span><span class="text-foreground"> curl -fsSL https://kortix.com/install | bash</span>`,
      );
      // An output line carries the emerald token.
      expect(html).toContain(
        `<span class="${OUTPUT}">→ stack up · dashboard registered as host &quot;selfhost&quot;</span>`,
      );
      expect(html).toContain(`<span class="${PROMPT}">$</span><span class="text-foreground"> kortix self-host status</span>`);
    }
  });

  test('keeps blanks and repeated lines as their own rows', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(<Panel title="t" lines={SHELL_LINES} lang="sh" />);
      // A blank renders as one space, not a dropped row; the snippet has two.
      expect(html.split('<span class="block whitespace-pre"> </span>').length - 1).toBe(2);
      // Every input line is exactly one row: 10 lines in, 10 rows out.
      expect(html.split(ROW).length - 1).toBe(SHELL_LINES.length);
    }
  });

  test('renders a non-snippet line in the plain value color', () => {
    for (const [page, Panel] of PANELS) {
      const yaml = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="yaml" />);
      expect(yaml).toContain(`<span class="${VALUE}">plain text</span>`);
      const sh = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="sh" />);
      expect(sh).toContain(`<span class="${VALUE}">plain text</span>`);
    }
  });

  test('renders the identical markup from all three module paths', () => {
    const rendered = PANELS.map(([, Panel]) => renderToStaticMarkup(<Panel title="t" lines={YAML_LINES} lang="yaml" />));
    expect(rendered[0]).toBe(rendered[1]);
    expect(rendered[0]).toBe(rendered[2]);
  });

  test('appends the caller className to the panel frame', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(
        <Panel title="t" lines={YAML_LINES} lang="yaml" className="min-w-0" />,
      );
      expect(html).toContain('class="border-border bg-card flex h-full flex-col rounded-sm border min-w-0"');
    }
  });
});
