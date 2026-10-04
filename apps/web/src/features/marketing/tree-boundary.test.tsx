import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RepoTree as CompanyTree } from './company-as-code/repo-tree';
import { FileTree } from './agent-computer/file-tree';
import { RepoTree as AgentsTree } from './agents-and-skills/repo-tree';
import { BoundaryDiagram as SecurityBoundary } from './security-page/boundary-diagram';
import { BoundaryDiagram as SelfHostedBoundary } from './self-hosted/boundary-diagram';

// Render shipped page content, with the English fallback from test-setup.ts.
// These snapshots pin the complete output before the shared-primitive refactor.
describe('marketing trees and boundaries characterization', () => {
  for (const [name, Component] of [
    ['company-as-code tree', CompanyTree],
    ['agent-computer tree', FileTree],
    ['agents-and-skills tree', AgentsTree],
    ['security boundary', SecurityBoundary],
    ['self-hosted boundary', SelfHostedBoundary],
  ] as const) {
    test(name, () => {
      expect(renderToStaticMarkup(<Component />)).toMatchSnapshot();
    });
  }

  test('company nested rails retain continuing and exhausted ancestors', () => {
    const rows = renderToStaticMarkup(<CompanyTree />).match(/<li class="contents">.*?<\/li>/g) ?? [];
    // SKILL.md: skills has later siblings, reconcile-invoices does not.
    expect(rows[7]).toContain('<span aria-hidden="true" class="relative w-5 shrink-0"><span class="bg-border absolute top-0 left-0 w-px bottom-0"></span></span><span aria-hidden="true" class="w-5 shrink-0"></span><span aria-hidden="true" class="relative w-5 shrink-0"><span class="bg-border absolute top-0 left-0 w-px h-1/2"></span><span class="bg-border absolute top-1/2 left-0 h-px w-2.5"></span></span>');
    expect(rows[7]).toContain('>SKILL.md</span>');
  });

  test('computer final branch has blank ancestors and tee then elbow', () => {
    const rows = renderToStaticMarkup(<FileTree />).match(/<li class="contents">.*?<\/li>/g) ?? [];
    expect(rows[5]).toContain('<span aria-hidden="true" class="w-6 shrink-0"></span><span aria-hidden="true" class="relative w-6 shrink-0"><span class="bg-border absolute top-0 left-0 w-px bottom-0"></span><span class="bg-border absolute top-1/2 left-0 h-px w-3"></span></span>');
    expect(rows[5]).toContain('>commands/</span>');
    expect(rows[6]).toContain('w-px h-1/2');
    expect(rows[6]).toContain('>plugins/</span>');
  });

  test('agents nested siblings retain the ancestor rail', () => {
    const rows = renderToStaticMarkup(<AgentsTree />).match(/<li class="contents">.*?<\/li>/g) ?? [];
    expect(rows[3]).toContain('<span aria-hidden="true" class="relative w-6 shrink-0"><span class="bg-border absolute top-0 left-0 w-px bottom-0"></span></span>');
    expect(rows[3]).toContain('>kortix.md</span>');
    expect(rows[4]).toContain('w-px h-1/2');
    expect(rows[4]).toContain('>harness-reflector.md</span>');
  });

  for (const [name, Component, variants] of [
    ['security', SecurityBoundary, ['border-border bg-background border border-dashed', 'border-border bg-background/40 border']],
    ['self-hosted', SelfHostedBoundary, ['border-border bg-background border', 'border-border bg-background/40 border border-dashed']],
  ] as const) {
    for (const [index, variant] of variants.entries()) {
      test(`${name} ${index === 0 ? 'inside/on' : 'outside/off'} column variant`, () => {
        const html = renderToStaticMarkup(<Component />);
        expect(html).toContain(`class="flex h-full flex-col rounded-sm p-5 sm:p-7 ${variant}"`);
        expect(html).toContain(index === 0
          ? 'class="mt-[7px] size-1.5 shrink-0 rounded-full bg-foreground"'
          : 'class="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/35"');
        expect(html).toContain(index === 0
          ? 'class="text-sm leading-relaxed text-foreground"'
          : 'class="text-sm leading-relaxed text-muted-foreground"');
      });
    }
  }
});
