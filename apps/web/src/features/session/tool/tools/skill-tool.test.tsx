import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSkillPurpose, SkillTool } from './skill-tool';

/**
 * The contract this file pins (spec W6, replacing the previous one).
 *
 * A skill call is a DISCLOSURE row, not a plain clickable row that navigates.
 * It used to be the latter: clicking anywhere on it jumped to `SKILL.md` in the
 * file preview, which meant the one step a reader skims past was also the one
 * that could take them out of the conversation, and the thing they actually
 * want — what the skill loaded — was nowhere on screen. Now the row expands in
 * place and carries an explicit "Open skill doc" action inside it.
 *
 * `role="button"` is on BOTH shapes and so proves nothing: `ClickableToolRow`
 * and `DisclosureTrigger` each set it. `aria-expanded` is the discriminator —
 * only the disclosure has an open state to report.
 *
 * The harness renders to static markup (this app has no DOM in tests), so a
 * click cannot be dispatched here. The action's target is asserted instead: the
 * button carries the resolved document path, which is the exact argument
 * `openPreview` receives. `skillDocumentPath`'s own resolution is covered in
 * `shared/skill-helpers.test.ts`.
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

describe('parseSkillPurpose', () => {
  const frontmatter = (body: string) => `---\n${body}\n---\n# Webapp\nBuild a web app.`;

  test('the frontmatter description is the purpose', () => {
    expect(parseSkillPurpose(frontmatter('name: webapp\ndescription: Build a web app.'))).toBe(
      'Build a web app.',
    );
  });

  test('only the first sentence — the rest is routing prose, not a subtitle', () => {
    // Real descriptions run past 700 characters and spend most of them on
    // "Load this when …"; see the shipped skills under packages/starter.
    const purpose = parseSkillPurpose(
      frontmatter('description: Build a web app. Load this when the user asks for a site.'),
    );
    expect(purpose).toBe('Build a web app.');
  });

  test('a quoted value loses its quotes, not its punctuation', () => {
    expect(parseSkillPurpose(frontmatter('description: "Deploy Kortix Apps."'))).toBe(
      'Deploy Kortix Apps.',
    );
  });

  test('a single-quoted value is unwrapped exactly like a double-quoted one', () => {
    // YAML treats both quote styles as the same scalar; the parser must not
    // pick one and hand the other back with its quotes still attached.
    expect(
      parseSkillPurpose(frontmatter("description: 'Deploy Kortix Apps. Use for deploys.'")),
    ).toBe('Deploy Kortix Apps.');
  });

  test('a block scalar has no value on its own line — the subtitle is omitted, not a bare | or >', () => {
    // `description: |` puts the text on the FOLLOWING lines. Read as a plain
    // value, the header itself became the subtitle: a row titled "webapp" with
    // a single "|" under it. Every indicator spelling fails closed.
    for (const header of ['|', '>', '|-', '>-', '|+', '>2', '|2-']) {
      expect(parseSkillPurpose(frontmatter(`description: ${header}\n  Build a web app.`))).toBe('');
    }
    // Mutation check: a value that merely STARTS with one of those characters
    // is a real description and must still come through.
    expect(parseSkillPurpose(frontmatter('description: |pipe| is the delimiter.'))).toBe(
      '|pipe| is the delimiter.',
    );
  });

  test('no frontmatter at all — the subtitle is simply omitted', () => {
    expect(parseSkillPurpose('# Webapp\nBuild a web app.')).toBe('');
  });

  test('frontmatter without a description — still omitted, never invented', () => {
    expect(parseSkillPurpose(frontmatter('name: webapp'))).toBe('');
  });
});

describe('SkillTool', () => {
  test('a named skill is a disclosure row, not a row that navigates on click', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT));
    expect(markup).toContain('aria-expanded="false"');
    // Collapsed: the body is closed, so nothing of the document is on screen.
    expect(markup).not.toContain('Build a web app.');
    expect(markup).not.toContain('Open skill doc');
  });

  test('the trigger is the skill name alone, with its purpose as the subtitle', () => {
    // The `Skill • ` prefix is gone: the row already carries the skill icon, and
    // the prefix cost half the line every reader has to scan.
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT));
    expect(markup).toContain('webapp');
    expect(markup).not.toContain('Skill &bull;');
    expect(markup).not.toContain('Skill •');
    expect(markup).toContain('Build and ship a web app.');
    // First sentence only — the routing half stays out of the row.
    expect(markup).not.toContain('Use when the user asks for a site.');
  });

  test('expanding shows what the skill loaded and the way into the document', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT), true);
    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
    expect(markup).toContain('Open skill doc');
    // The action's target IS the argument `openPreview` gets.
    expect(markup).toContain(`title="${DIR}/SKILL.md"`);
  });

  test('the purpose is not printed twice — the frontmatter never reaches the body', () => {
    const markup = render(part({ name: 'webapp', dir: DIR }, OUTPUT), true);
    // The raw YAML would otherwise render as a stray paragraph under the title.
    expect(markup).not.toContain('name: webapp');
    expect(markup).not.toContain('description:');
    // Twice and only twice, and both are the subtitle: the visible span and its
    // native `title` tooltip, which the shell adds because the row truncates.
    // A third occurrence means the body is echoing the trigger.
    expect(markup.split('Build and ship a web app.').length - 1).toBe(2);
  });

  test('a named skill with no directory in the payload still reaches its document', () => {
    // The runtime need not send a directory anywhere, and for a long time it did
    // not. The name is enough: skills install at `.kortix/opencode/skills/<name>/`.
    const markup = render(part({ name: 'webapp' }, OUTPUT_NO_DIR), true);
    expect(markup).toContain('title=".kortix/opencode/skills/webapp/SKILL.md"');
  });

  // Task 20: the file list's heading used to be `text-sm ... uppercase`, one
  // notch off the trigger's own weight, directly under a row that already
  // names the skill and badges the file count. It is the sanctioned 10px
  // section label now — the grouping survives, the second title does not.
  test('the file list is labelled at section weight, not at heading weight', () => {
    // On the panel, where the row carries the badge that counts the files.
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ToolSurfaceContext.Provider value="panel">
            <SkillTool part={part({ name: 'webapp', dir: DIR }, OUTPUT)} defaultOpen />
          </ToolSurfaceContext.Provider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    // The row's own badge still counts them.
    expect(markup).toContain('2 files');
    // The body still groups them under a label…
    expect(markup).toContain('Files');
    expect(markup).toContain('text-[10px] font-medium tracking-wider uppercase');
    // …and no longer shouts it at `text-sm`.
    expect(markup).not.toContain('text-sm font-medium tracking-wide uppercase');
  });

  test('a skill with no usable name expands in place and offers no doc action', () => {
    // Nothing to point the panel at, and a made-up path would open an error.
    // The inline body is the whole answer, and it still carries the document.
    const markup = render(part({}, OUTPUT_NO_DIR), true);
    expect(markup).toContain('Build a web app.');
    expect(markup).toContain('reference.md');
    expect(markup).toContain('templates/page.tsx');
    expect(markup).not.toContain('Open skill doc');
  });
});
