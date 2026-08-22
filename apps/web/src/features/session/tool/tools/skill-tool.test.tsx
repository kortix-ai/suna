import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillTool } from './skill-tool';

/**
 * The contract this file pins.
 *
 * A skill call is the same disclosure as Read / Edit: title is the tool
 * ("Skill"), subtitle is the skill name, and clicking the subtitle opens
 * `SKILL.md` in the session preview. The row expands in place onto
 * `ToolMarkdownCard` + `ToolResultCard` — not a nested scroll box, not a
 * second "Open skill doc" button.
 *
 * `aria-expanded` is the discriminator — only the disclosure has an open
 * state to report. The harness renders to static markup (this app has no DOM
 * in tests), so a click cannot be dispatched here. The subtitle's click
 * affordance is the `hover:underline` class `onSubtitleClick` adds; when
 * there is no document to open, that class is absent.
 */

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

const DIR = '/workspace/.opencode/skill/webapp';

/** What the runtime actually sends: the base directory lives in the OUTPUT. */
const OUTPUT = [
  '<skill_content>',
  '---',
  'name: webapp',
  'description: Build and ship a web app. Use when the user asks for a site.',
  '---',
  '# Webapp',
  'Build a web app.',
  '',
  `Base directory: ${DIR}`,
  '<skill_files>',
  '<file>reference.md</file>',
  '<file>templates/page.tsx</file>',
  '</skill_files>',
  '</skill_content>',
].join('\n');

/** The same call with no base directory and no frontmatter anywhere. */
const OUTPUT_NO_DIR = [
  '<skill_content>',
  '# Webapp',
  'Build a web app.',
  '<skill_files>',
  '<file>reference.md</file>',
  '<file>templates/page.tsx</file>',
  '</skill_files>',
  '</skill_content>',
].join('\n');

describe('SkillTool', () => {
  test('a named skill is a disclosure row, not a row that navigates on click', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Build a web app.');
    expect(markup).not.toContain('Open skill doc');
  });

  test('the trigger is Skill plus the skill name, like Read plus a filename', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT));
    expect(markup).toContain('Skill');
    expect(markup).toContain('webapp');
    expect(markup).not.toContain('Skill &bull;');
    expect(markup).not.toContain('Skill •');
    // Purpose lives in the expanded frontmatter card, not on the closed row.
    expect(markup).not.toContain('Build and ship a web app.');
    expect(markup).toContain('hover:underline');
  });

  test('expanding shows the document in a markdown card and the files in a result card', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT), true);
    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
    expect(markup).toContain('Build a web app.');
    expect(markup).not.toContain('Open skill doc');
    // Directory-listing chrome, not a labelled "Files" section.
    expect(markup).not.toContain('text-[10px] font-medium tracking-wider uppercase');
  });

  test('frontmatter is a metadata card, not a stray YAML paragraph', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT), true);
    expect(markup).not.toContain('description:');
    // The description value is the frontmatter card's body, not a second subtitle.
    expect(markup).toContain('Build and ship a web app.');
  });

  test('a named skill with no directory in the payload still offers the subtitle click', () => {
    const markup = render(part({ name: 'webapp' }, OUTPUT_NO_DIR), true);
    expect(markup).toContain('hover:underline');
    expect(markup).toContain('webapp');
  });

  test('on the panel the files still sit in the result card, not a section heading', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ToolSurfaceContext.Provider value="panel">
            <SkillTool part={part({ name: 'webapp', dir: DIR }, OUTPUT)} defaultOpen />
          </ToolSurfaceContext.Provider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
    expect(markup).not.toContain('2 files');
    expect(markup).not.toContain('text-[10px] font-medium tracking-wider uppercase');
  });

  test('a skill with no usable name expands in place and offers no doc click', () => {
    const markup = render(part({}, OUTPUT_NO_DIR), true);
    expect(markup).toContain('Build a web app.');
    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
    expect(markup).not.toContain('hover:underline');
    expect(markup).not.toContain('Open skill doc');
  });
});
