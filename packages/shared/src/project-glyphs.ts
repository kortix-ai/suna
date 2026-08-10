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
 * WHY 202. Each Phosphor module carries ~3.5 KB of path data (all six weights
 * ship together per icon, though the app paints only `bold`). Measured across
 * the package: 5,269,143 bytes for 1512 icons. 202 is ~704 KB raw — statically
 * importable, and well under budget gzipped. The full set would need dynamic
 * import or a generated sprite plus a loading state inside the tab.
 *
 * Letters and digits are deliberately absent. Phosphor has no alphabet (only
 * LetterCircleH/P/V, three strays), and mixing typographic letters with drawn
 * glyphs would make the tab read as two families. The Numbers group is the one
 * deliberate exception: NumberCircle* glyphs are drawn pictograms (a digit set
 * inside a circle), not typographic characters, so they stay visually
 * consistent with the rest of the catalogue.
 */

export const WORKSPACE_GLYPH_GROUPS = [
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
      'Key',
      'Lock',
      'Umbrella',
      'Trophy',
    ],
  },
  {
    label: 'Shapes',
    names: [
      'Circle',
      'Square',
      'Triangle',
      'Diamond',
      'Hexagon',
      'Star',
      'Heart',
      'Lightning',
      'Spade',
      'Club',
      'Cube',
      'Polygon',
    ],
  },
  {
    label: 'Files',
    names: [
      'File',
      'FileText',
      'Folder',
      'FolderOpen',
      'Note',
      'Book',
      'Newspaper',
      'Paperclip',
      'Archive',
      'Notebook',
      'Files',
      'FolderPlus',
    ],
  },
  {
    label: 'Actions',
    names: [
      'Plus',
      'Minus',
      'Copy',
      'Check',
      'X',
      'Pencil',
      'Bookmark',
      'Eraser',
      'Scissors',
      'LinkSimple',
      'ShareNetwork',
      'Clipboard',
    ],
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
      'ArrowsLeftRight',
      'ArrowUUpLeft',
      'ArrowsOut',
      'ArrowsIn',
    ],
  },
  {
    label: 'Tech',
    names: [
      'Code',
      'Terminal',
      'Database',
      'Cloud',
      'Cpu',
      'Bug',
      'GitBranch',
      'Rocket',
      'Monitor',
      'DeviceMobile',
      'Keyboard',
      'Robot',
    ],
  },
  {
    label: 'Nature',
    names: [
      'Leaf',
      'Tree',
      'Sun',
      'Moon',
      'Drop',
      'Fire',
      'Mountains',
      'Planet',
      'Flower',
      'Cactus',
      'Snowflake',
      'Rainbow',
    ],
  },
  {
    label: 'Symbols',
    names: [
      'Hash',
      'At',
      'Percent',
      'Asterisk',
      'Question',
      'Warning',
      'Info',
      'Bell',
      'Crown',
      'Flag',
      'Medal',
      'Sparkle',
    ],
  },
  {
    label: 'Food',
    names: [
      'Carrot',
      'Pizza',
      'Hamburger',
      'IceCream',
      'Coffee',
      'BeerStein',
      'Cookie',
      'Cake',
      'Egg',
      'Bread',
      'Wine',
      'Martini',
    ],
  },
  {
    label: 'Animals',
    names: [
      'Dog',
      'Cat',
      'Bird',
      'Butterfly',
      'Rabbit',
      'Horse',
      'Cow',
      'PawPrint',
      'Fish',
      'Shrimp',
      'Feather',
      'Bone',
    ],
  },
  {
    label: 'Transport',
    names: [
      'Car',
      'Bus',
      'Truck',
      'Train',
      'Airplane',
      'Bicycle',
      'Motorcycle',
      'Boat',
      'Scooter',
      'Taxi',
      'Van',
      'Jeep',
    ],
  },
  {
    label: 'People',
    names: [
      'User',
      'Users',
      'Smiley',
      'SmileyMeh',
      'SmileySad',
      'Ghost',
      'Alien',
      'Baby',
      'PersonSimpleRun',
      'Hand',
      'ThumbsUp',
      'Eye',
    ],
  },
  {
    label: 'Music',
    names: [
      'MusicNote',
      'MusicNotes',
      'Guitar',
      'Microphone',
      'SpeakerHigh',
      'Radio',
      'Playlist',
      'Metronome',
      'Waveform',
      'Disc',
      'Headphones',
      'Equalizer',
    ],
  },
  {
    label: 'Sport',
    names: [
      'Basketball',
      'Football',
      'SoccerBall',
      'Baseball',
      'TennisBall',
      'Barbell',
      'Target',
      'Golf',
      'Volleyball',
      'PingPong',
      'Racquet',
      'PersonSimpleSwim',
    ],
  },
  {
    label: 'Money',
    names: [
      'CurrencyDollar',
      'Wallet',
      'CreditCard',
      'PiggyBank',
      'Coins',
      'Receipt',
      'Bank',
      'ChartLine',
      'Tag',
      'ChartBar',
      'ChartPie',
      'Handshake',
    ],
  },
  {
    label: 'Care',
    names: [
      'CloudRain',
      'CloudSnow',
      'CloudLightning',
      'Wind',
      'Thermometer',
      'Sunglasses',
      'Heartbeat',
      'Pill',
      'FirstAid',
      'Syringe',
      'Bandaids',
      'Stethoscope',
    ],
  },
  {
    label: 'Numbers',
    names: [
      'NumberCircleZero',
      'NumberCircleOne',
      'NumberCircleTwo',
      'NumberCircleThree',
      'NumberCircleFour',
      'NumberCircleFive',
      'NumberCircleSix',
      'NumberCircleSeven',
      'NumberCircleEight',
      'NumberCircleNine',
    ],
  },
] as const;

export const WORKSPACE_GLYPH_NAMES = WORKSPACE_GLYPH_GROUPS.flatMap(
  (group) => group.names,
) as readonly string[];

/**
 * `grey` first because it is the default on a first pick — an unedited glyph
 * project should look deliberately neutral, not randomly coloured.
 */
export const WORKSPACE_GLYPH_COLORS = [
  'grey',
  'red',
  'orange',
  'yellow',
  'lime',
  'blue',
  'purple',
  'magenta',
] as const;

export type WorkspaceGlyphName = (typeof WORKSPACE_GLYPH_GROUPS)[number]['names'][number];
export type WorkspaceGlyphColor = (typeof WORKSPACE_GLYPH_COLORS)[number];

export interface WorkspaceGlyph {
  name: WorkspaceGlyphName;
  color: WorkspaceGlyphColor;
}

const NAME_SET: ReadonlySet<string> = new Set(WORKSPACE_GLYPH_NAMES);
const COLOR_SET: ReadonlySet<string> = new Set(WORKSPACE_GLYPH_COLORS);

export function isWorkspaceGlyphName(value: unknown): value is WorkspaceGlyphName {
  return typeof value === 'string' && NAME_SET.has(value);
}

export function isWorkspaceGlyphColor(value: unknown): value is WorkspaceGlyphColor {
  return typeof value === 'string' && COLOR_SET.has(value);
}

/** @deprecated Use Workspace glyph names. */
export const PROJECT_GLYPH_GROUPS = WORKSPACE_GLYPH_GROUPS;
/** @deprecated Use Workspace glyph names. */
export const PROJECT_GLYPH_NAMES = WORKSPACE_GLYPH_NAMES;
/** @deprecated Use Workspace glyph names. */
export const PROJECT_GLYPH_COLORS = WORKSPACE_GLYPH_COLORS;
/** @deprecated Use WorkspaceGlyphName. */
export type ProjectGlyphName = WorkspaceGlyphName;
/** @deprecated Use WorkspaceGlyphColor. */
export type ProjectGlyphColor = WorkspaceGlyphColor;
/** @deprecated Use WorkspaceGlyph. */
export type ProjectGlyph = WorkspaceGlyph;
/** @deprecated Use isWorkspaceGlyphName. */
export const isProjectGlyphName = isWorkspaceGlyphName;
/** @deprecated Use isWorkspaceGlyphColor. */
export const isProjectGlyphColor = isWorkspaceGlyphColor;
