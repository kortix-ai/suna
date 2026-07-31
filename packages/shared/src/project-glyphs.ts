/**
 * The glyphs and colours a project icon can use.
 *
 * This list is the ONE source of truth. `apps/api` imports it to allowlist what
 * may be written to `metadata.icon_glyph`; `apps/web` imports it to build the
 * picker grid and the name -> component registry. Keeping it here is what makes
 * "the API accepts exactly what the UI can render" true by construction rather
 * than by review.
 *
 * Every name is a PascalCase `@phosphor-icons/react` export, verified present in
 * 2.1.10. Adding one means adding it here AND to the web registry — a test in
 * apps/web asserts every name resolves to a real component, so a name added
 * here alone fails CI rather than shipping a blank tile.
 *
 * WHY 64. Each Phosphor module carries ~3.5 KB of path data (all six weights
 * ship together per icon, though the app paints only `bold`). Measured across
 * the package: 5,269,143 bytes for 1512 icons. 64 is ~224 KB raw — statically
 * importable and well under 70 KB gzipped. The full set would need dynamic
 * import or a generated sprite plus a loading state inside the tab.
 *
 * Letters and digits are deliberately absent. Phosphor has no alphabet (only
 * LetterCircleH/P/V, three strays), and mixing typographic letters with drawn
 * glyphs would make the tab read as two families.
 */

export const PROJECT_GLYPH_GROUPS = [
  {
    label: 'Objects',
    names: [
      'Trash',
      'ShoppingCart',
      'Package',
      'Briefcase',
      'Gift',
      'Lightbulb',
      'Wrench',
      'Hammer',
    ],
  },
  {
    label: 'Shapes',
    names: ['Circle', 'Square', 'Triangle', 'Diamond', 'Hexagon', 'Star', 'Heart', 'Lightning'],
  },
  {
    label: 'Files',
    names: ['File', 'FileText', 'Folder', 'FolderOpen', 'Note', 'Book', 'Newspaper', 'Paperclip'],
  },
  {
    label: 'Actions',
    names: ['Plus', 'Minus', 'Copy', 'Clipboard', 'Check', 'X', 'Pencil', 'Bookmark'],
  },
  {
    label: 'Arrows',
    names: [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowsClockwise',
      'ArrowSquareOut',
      'TrendUp',
      'TrendDown',
    ],
  },
  {
    label: 'Tech',
    names: ['Code', 'Terminal', 'Database', 'Cloud', 'Cpu', 'Bug', 'GitBranch', 'Rocket'],
  },
  {
    label: 'Nature',
    names: ['Leaf', 'Tree', 'Sun', 'Moon', 'Drop', 'Fire', 'Mountains', 'Planet'],
  },
  {
    label: 'Symbols',
    names: ['Hash', 'At', 'Percent', 'Asterisk', 'Question', 'Warning', 'Info', 'Bell'],
  },
] as const;

export const PROJECT_GLYPH_NAMES = PROJECT_GLYPH_GROUPS.flatMap(
  (group) => group.names,
) as readonly string[];

/**
 * `grey` first because it is the default on a first pick — an unedited glyph
 * project should look deliberately neutral, not randomly coloured.
 */
export const PROJECT_GLYPH_COLORS = [
  'grey',
  'red',
  'orange',
  'yellow',
  'lime',
  'blue',
  'purple',
  'magenta',
] as const;

export type ProjectGlyphName = (typeof PROJECT_GLYPH_GROUPS)[number]['names'][number];
export type ProjectGlyphColor = (typeof PROJECT_GLYPH_COLORS)[number];

export interface ProjectGlyph {
  name: ProjectGlyphName;
  color: ProjectGlyphColor;
}

const NAME_SET: ReadonlySet<string> = new Set(PROJECT_GLYPH_NAMES);
const COLOR_SET: ReadonlySet<string> = new Set(PROJECT_GLYPH_COLORS);

export function isProjectGlyphName(value: unknown): value is ProjectGlyphName {
  return typeof value === 'string' && NAME_SET.has(value);
}

export function isProjectGlyphColor(value: unknown): value is ProjectGlyphColor {
  return typeof value === 'string' && COLOR_SET.has(value);
}
