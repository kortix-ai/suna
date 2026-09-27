import { describe, expect, test } from 'bun:test';

import { parseFrontmatter } from '../tool-part-accessors';
import { skillBody } from './web-skill';

// Port of apps/web `tool/tools/skill-tool.test.tsx` over what the row decides:
// the trigger (Skill + the skill name), whether the subtitle opens SKILL.md,
// and what the expanded body holds (document card + file list).

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

describe('skill row', () => {
  test('the trigger is Skill plus the skill name, like Read plus a filename', () => {
    const body = skillBody({ name: 'webapp', dir: DIR }, OUTPUT, 'completed');
    expect(body.trigger).toEqual({ title: 'Skill', subtitle: 'webapp' });
    // Purpose lives in the expanded frontmatter card, not on the closed row.
    expect(JSON.stringify(body.trigger)).not.toContain('Build and ship a web app.');
    expect(body.trigger.title).not.toContain('•');
    expect(body.docPath).toBe(`${DIR}/SKILL.md`);
  });

  test('expanding shows the document and the files', () => {
    const body = skillBody({ name: 'webapp', dir: DIR }, OUTPUT, 'completed');
    expect(body.hasBody).toBe(true);
    expect(body.files).toEqual(['reference.md', 'templates/page.tsx']);
    expect(body.document).toContain('Build a web app.');
    expect(body.document).not.toContain('Base directory:');
    expect(body.document).not.toContain('<skill_files>');
  });

  test('frontmatter is a metadata card, not a stray YAML paragraph', () => {
    const body = skillBody({ name: 'webapp', dir: DIR }, OUTPUT, 'completed');
    const { frontmatter, body: markdown } = parseFrontmatter(body.document);
    expect(frontmatter?.description).toBe('Build and ship a web app. Use when the user asks for a site.');
    expect(markdown).not.toContain('description:');
  });

  test('a named skill with no directory in the payload still offers the subtitle tap', () => {
    const body = skillBody({ name: 'webapp' }, OUTPUT_NO_DIR, 'completed');
    expect(body.docPath).not.toBeNull();
    expect(body.trigger.subtitle).toBe('webapp');
  });

  test('a skill with no usable name expands in place and offers no document tap', () => {
    const body = skillBody({}, OUTPUT_NO_DIR, 'completed');
    expect(body.trigger).toEqual({ title: 'Skill', subtitle: undefined });
    expect(body.docPath).toBeNull();
    expect(body.document).toContain('Build a web app.');
    expect(body.files).toEqual(['reference.md', 'templates/page.tsx']);
  });

  test('a running call has no body; a JSON failure is a failure', () => {
    expect(skillBody({ name: 'webapp' }, OUTPUT, 'running').hasBody).toBe(false);
    const failed = skillBody({ name: 'x' }, JSON.stringify({ success: false, error: 'not found' }), 'completed');
    expect(failed.failure).not.toBeNull();
  });
});
