import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillTool } from './skill-tool';

const part = (input: Record<string, unknown>, output: string): ToolPart =>
  ({
    id: '1',
    type: 'tool',
    tool: 'skill',
    callID: 'c1',
    state: { status: 'completed', input, output, time: { start: 1, end: 2 } },
  }) as unknown as ToolPart;

const render = (p: ToolPart, open = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <SkillTool part={p} defaultOpen={open} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

const OUTPUT = [
  '<skill_content>',
  '# Webapp',
  'Build a web app.',
  '<skill_files>',
  '<file>reference.md</file>',
  '<file>templates/page.tsx</file>',
  '</skill_files>',
  '</skill_content>',
].join('\n');

const DIR = '/workspace/.opencode/skill/webapp';

describe('SkillTool', () => {
  test('a skill with a directory is a plain row that opens the detail panel', () => {
    // It used to raise a second right-hand `Sheet` — its own header, its own
    // scroll, its own copy of the markdown — on top of the panel that already
    // exists for exactly this. A file click in a read row goes to the detail
    // view; a skill is a document in the project, so it goes to the same place.
    //
    // `BasicTool` renders a plain button (not a disclosure) when given
    // `onClick`, so the inline body is deliberately absent here: the panel shows
    // the real SKILL.md rather than a duplicate rendered in the transcript.
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT));
    expect(markup).toContain('Skill');
    expect(markup).toContain('webapp');
    expect(markup).toContain('role="button"');
    expect(markup).not.toContain('Build a web app.');
  });

  test('a skill with NO directory has nothing to open, so it falls back to expanding', () => {
    // There is no path to hand the panel, and `${''}/SKILL.md` would be a lie.
    // The inline body is the fallback, and it still carries the whole document.
    const markup = render(part({ name: 'webapp' }, OUTPUT), true);
    expect(markup).toContain('Build a web app.');
    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
  });
});
