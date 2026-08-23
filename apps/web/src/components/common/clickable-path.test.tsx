import { describe, expect, it } from 'bun:test';
import { Children, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveOpenablePath, wrapChildrenWithPaths } from './clickable-path';

// ─── Agents write workspace-relative paths far more often than absolute ones.
// This component used to reject anything without a leading slash, so clicking
// `docs/bio.md` in chat produced "Cannot open relative path" for a file that
// exists. Resolution — not rejection — is what the rest of the app does with
// these same strings. ───────────────────────────────────────────────────────

describe('resolveOpenablePath', () => {
  it('anchors a workspace-relative path under /workspace', () => {
    expect(resolveOpenablePath('docs/jay-suthar-bio.md')).toBe('/workspace/docs/jay-suthar-bio.md');
  });

  it('anchors a bare filename', () => {
    expect(resolveOpenablePath('README.md')).toBe('/workspace/README.md');
  });

  it('passes an already-absolute workspace path through unchanged', () => {
    expect(resolveOpenablePath('/workspace/src/index.ts')).toBe('/workspace/src/index.ts');
  });

  it('leaves the other allowed sandbox roots alone', () => {
    expect(resolveOpenablePath('/tmp/out.log')).toBe('/tmp/out.log');
    expect(resolveOpenablePath('/home/user/.bashrc')).toBe('/home/user/.bashrc');
  });

  it('tolerates surrounding whitespace from a text scan', () => {
    expect(resolveOpenablePath('  docs/bio.md  ')).toBe('/workspace/docs/bio.md');
  });

  it('returns null for an empty or whitespace-only path rather than /workspace', () => {
    expect(resolveOpenablePath('')).toBeNull();
    expect(resolveOpenablePath('   ')).toBeNull();
  });
});

// ─── A code fence is not prose. Both markdown renderers replace `code`/`pre`/
// `a` with custom components, so the old `typeof el.type === 'string'` guard
// matched nothing and path detection walked straight into every fence body: a
// `bash` block containing `./Setup.sh` had that string swapped for a React
// element, and `String(children)` downstream rendered `[object Object]` in
// place of the whole snippet. ──────────────────────────────────────────────

function CustomCode(props: { className?: string; children?: ReactNode; node?: unknown }) {
  return <code className={props.className}>{props.children}</code>;
}

function onlyChild(node: ReactNode): ReactElement<{ children?: ReactNode }> {
  const list = Children.toArray(node);
  expect(list.length).toBe(1);
  return list[0] as ReactElement<{ children?: ReactNode }>;
}

describe('wrapChildrenWithPaths', () => {
  it('leaves a custom code component identified by its hast node untouched', () => {
    const fence = (
      <CustomCode className="language-bash" node={{ tagName: 'code' }}>
        {'./Setup.sh\n'}
      </CustomCode>
    );

    const wrapped = onlyChild(wrapChildrenWithPaths(fence));

    expect(wrapped.props.children).toBe('./Setup.sh\n');
  });

  it('leaves a custom code component identified by language-* untouched', () => {
    const fence = <CustomCode className="language-bash">{'./Setup.sh\n'}</CustomCode>;

    const wrapped = onlyChild(wrapChildrenWithPaths(fence));

    expect(wrapped.props.children).toBe('./Setup.sh\n');
  });

  it('leaves a custom anchor component untouched', () => {
    const link = (
      <CustomCode node={{ tagName: 'a' }}>{'see docs/readme.md for details'}</CustomCode>
    );

    const wrapped = onlyChild(wrapChildrenWithPaths(link));

    expect(wrapped.props.children).toBe('see docs/readme.md for details');
  });

  it('still makes a path clickable in ordinary prose', () => {
    const html = renderToStaticMarkup(<>{wrapChildrenWithPaths('open docs/readme.md now')}</>);

    expect(html).toContain('docs/readme.md — Click to preview');
  });

  it('still recurses through inline emphasis', () => {
    const html = renderToStaticMarkup(
      <>{wrapChildrenWithPaths(<strong>{'open docs/readme.md now'}</strong>)}</>,
    );

    expect(html).toContain('docs/readme.md — Click to preview');
  });
});

// ─── One path, one button ───────────────────────────────────────────────────
// `li` wraps its children and the nested `p` wraps them again, so the walk used
// to descend into the span the first pass produced: nested `role="button"`
// elements, two handlers on one path. ───────────────────────────────────────

describe('wrapChildrenWithPaths double pass', () => {
  it('does not nest a second ClickablePath inside the first', () => {
    const once = wrapChildrenWithPaths('open docs/readme.md now');
    const twice = wrapChildrenWithPaths(once);

    const html = renderToStaticMarkup(<>{twice}</>);
    const buttons = html.match(/role="button"/g) ?? [];

    expect(buttons.length).toBe(1);
  });
});
