/**
 * A write applies the edited object to the file's own text: every comment and
 * every line the edit does not touch keep their bytes, and the text reads as
 * exactly the edited object. Synthetic manifests only.
 */
import { describe, expect, test } from 'bun:test';
import { parseManifestText, rewriteManifestText } from '../index.ts';

const SOURCE = [
  '# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json',
  '# The project manifest: comments explain each grant. Keep them.',
  'project:',
  '  name: "Synthetic"   # quoted on purpose',
  '',
  '# The agent a session runs when it names none.',
  'default_agent: worker',
  '',
  '# Project skills, registered by name.',
  'skills: {}',
  '',
  'agents:',
  '  worker:',
  `    description: "${'A long description that goes past eighty characters, '.repeat(2).trim()}"`,
  '    tools: [read, bash]',
  '    # Full checkout: this agent edits files.',
  '    workspace: { project_repository: true }',
  '    secrets: all',
  '',
  '# More you can add here: sandbox.templates, tools, triggers.',
  '',
].join('\n');

const edit = (change: (raw: Record<string, any>) => void) => {
  const raw = structuredClone(parseManifestText(SOURCE)) as Record<string, any>;
  change(raw);
  return { raw, text: rewriteManifestText(SOURCE, raw) };
};
const removedLines = (text: string) => SOURCE.split('\n').filter((line) => !text.split('\n').includes(line));
const addedLines = (text: string) => text.split('\n').filter((line) => !SOURCE.split('\n').includes(line));

describe('rewriteManifestText', () => {
  test('adding a registry entry changes only that key, comments kept', () => {
    const { raw, text } = edit((r) => { r.skills = { 'release-notes': 'skills/release-notes' }; });
    expect(text).not.toBeNull();
    expect(parseManifestText(text!)).toEqual(raw);
    expect(removedLines(text!)).toEqual(['skills: {}']);
    expect(addedLines(text!)).toEqual(['skills:', '  release-notes: skills/release-notes']);
  });

  test('changing a nested agent key changes only that line', () => {
    const { raw, text } = edit((r) => { r.agents.worker.secrets = ['HELPDESK_TOKEN']; });
    expect(parseManifestText(text!)).toEqual(raw);
    expect(removedLines(text!)).toEqual(['    secrets: all']);
    expect(addedLines(text!)).toEqual(['    secrets:', '      - HELPDESK_TOKEN']);
  });

  test('deleting a key removes its lines and keeps every other comment', () => {
    const { raw, text } = edit((r) => { delete r.agents.worker.secrets; });
    expect(parseManifestText(text!)).toEqual(raw);
    expect(removedLines(text!)).toEqual(['    secrets: all']);
    expect(addedLines(text!)).toEqual([]);
  });

  test('an unchanged object returns the same bytes', () => {
    expect(rewriteManifestText(SOURCE, parseManifestText(SOURCE))).toBe(SOURCE);
  });

  test('text that does not parse gives null: the caller re-renders', () => {
    expect(rewriteManifestText('agents: [\n', { agents: {} })).toBeNull();
  });
});
