/**
 * Default Space templates and the pure manifest write that creates a Space.
 *
 * A Space is a `domains.<slug>` entry in `kortix.yaml` (see `SpaceBlock` /
 * `ProjectDomain` in `@kortix/sdk`). Creating one writes a new entry. These
 * presets are starting scaffolds — an agent or the user edits the blocks after.
 * Framework-free so it is unit-testable and host-agnostic.
 */

import { parseDocument } from 'yaml';

import type { SpaceBlock } from '@kortix/sdk';

export interface SpaceTemplate {
  id: string;
  label: string;
  description: string;
  blocks: SpaceBlock[];
}

/** The presets the "New space" picker offers, in order. Keep this short. */
export const SPACE_TEMPLATES: SpaceTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'An empty space you fill in yourself.',
    blocks: [],
  },
  {
    id: 'channel',
    label: 'Channel',
    description: 'One shared chat room for the space.',
    // room is left empty and defaulted to the space slug at create time, so
    // each Channel space gets its own session instead of sharing one.
    blocks: [{ type: 'chat', label: 'Chat' }],
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'A Kortix App beside an embedded page.',
    blocks: [
      { type: 'app', label: 'App' },
      { type: 'iframe', label: 'Embed', url: 'https://example.com' },
    ],
  },
  {
    id: 'docs',
    label: 'Docs',
    description: 'A document from the project files.',
    blocks: [{ type: 'artifact', label: 'Doc', path: 'docs/README.md' }],
  },
];

/** Turn a space name into a manifest-safe `domains:` key. */
export function slugifySpace(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 64) || 'space'
  );
}

/** Resolve a template's blocks for a concrete space: a chat block with no
 *  room defaults to the space slug so channels don't collide. */
export function spaceBlocks(template: SpaceTemplate, slug: string): SpaceBlock[] {
  return template.blocks.map((block) =>
    block.type === 'chat' && !block.room ? { ...block, room: slug } : block,
  );
}

/**
 * Add `domains.<slug>` to a `kortix.yaml` text, creating the `domains:` map if
 * absent. Round-trips through the `yaml` document model so comments and the
 * rest of the manifest are preserved. Returns the new YAML text.
 */
export function addSpaceToManifest(
  yamlText: string,
  input: { slug: string; label: string; blocks: SpaceBlock[] },
): string {
  const doc = parseDocument(yamlText);
  doc.setIn(['domains', input.slug], {
    label: input.label,
    blocks: input.blocks,
  });
  return doc.toString();
}
