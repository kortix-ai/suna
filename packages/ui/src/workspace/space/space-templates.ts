/**
 * Space templates and the pure `kortix.yaml` edits that create a space and
 * set its tabs. A space is `spaces.<slug>` (see `ProjectSpace` in
 * `@kortix/sdk`). Every edit round-trips through the `yaml` document model,
 * so comments and the rest of the manifest stay as they were.
 */

import { isSeq, parseDocument } from 'yaml';

import { DEFAULT_SPACE_TABS, type SpaceTab } from '@kortix/sdk';

export interface SpaceTemplate {
  /** Also the catalog key of its name and hint: `spaces.templates.<id>`. */
  id: 'standard' | 'room' | 'board';
  /** The tabs after the room. */
  tabs: SpaceTab[];
}

/** The presets the New space dialog offers, in order. The first is the default. */
export const SPACE_TEMPLATES: SpaceTemplate[] = [
  {
    id: 'standard',
    tabs: [...DEFAULT_SPACE_TABS],
  },
  {
    id: 'room',
    tabs: [],
  },
  {
    id: 'board',
    tabs: [
      { type: 'board', label: 'Board', blocks: [{ type: 'text', label: 'Brief', text: 'What this space is for, and how to help.' }] },
      { type: 'goals' },
    ],
  },
];

/** Turn a space name into a `spaces:` key. The result is also a valid room
 *  name (the space's room is the room with its slug): at most 63 characters,
 *  starting with a letter or a digit. */
export function slugifySpace(name: string): string {
  const trim = (value: string) => value.replace(/^[-_]+|[-_]+$/g, '');
  return (
    trim(
      trim(
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/-{2,}/g, '-'),
      ).slice(0, 63),
    ) || 'space'
  );
}

/** Add `spaces.<slug>` to a `kortix.yaml` text. Returns the new text. */
export function addSpaceToManifest(
  yamlText: string,
  input: { slug: string; label: string; description?: string; tabs: SpaceTab[] },
): string {
  const doc = parseDocument(yamlText);
  const description = input.description?.trim();
  doc.setIn(['spaces', input.slug], {
    label: input.label,
    ...(description ? { description } : {}),
    tabs: input.tabs,
  });
  return doc.toString();
}

/** Replace `spaces.<slug>.tabs` in a `kortix.yaml` text, declaring the space
 *  when only an agent names it. Returns the new text. */
export function setSpaceTabs(yamlText: string, slug: string, tabs: SpaceTab[]): string {
  const doc = parseDocument(yamlText);
  doc.setIn(['spaces', slug, 'tabs'], tabs);
  return doc.toString();
}

/** Append one tab to `spaces.<slug>.tabs` as the file has it now. A space
 *  with no `tabs` shows the default set, so the new list starts from it. */
export function appendSpaceTab(yamlText: string, slug: string, tab: SpaceTab): string {
  const doc = parseDocument(yamlText);
  const current = doc.getIn(['spaces', slug, 'tabs']);
  const tabs = isSeq(current) ? (current.toJSON() as SpaceTab[]) : [...DEFAULT_SPACE_TABS];
  doc.setIn(['spaces', slug, 'tabs'], [...tabs, tab]);
  return doc.toString();
}
