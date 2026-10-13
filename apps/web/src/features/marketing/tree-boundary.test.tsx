import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RepoTree as AgentsTree } from './agents-and-skills/repo-tree';

// Render shipped page content, with the English fallback from test-setup.ts.
// The agents tree is the last user of the shared `RepoTreeRows` primitive.
describe('marketing repo tree characterization', () => {
  test('agents-and-skills tree', () => {
    expect(renderToStaticMarkup(<AgentsTree />)).toMatchSnapshot();
  });

  test('agents nested siblings retain the ancestor rail', () => {
    const rows = renderToStaticMarkup(<AgentsTree />).match(/<li class="contents">.*?<\/li>/g) ?? [];
    expect(rows[3]).toContain('<span aria-hidden="true" class="relative w-6 shrink-0"><span class="bg-border absolute top-0 left-0 w-px bottom-0"></span></span>');
    expect(rows[3]).toContain('>kortix.md</span>');
    expect(rows[4]).toContain('>harness-reflector.md</span>');
    expect(rows[5]).toContain('w-px h-1/2');
    expect(rows[5]).toContain('>session-reviewer.md</span>');
  });
});
