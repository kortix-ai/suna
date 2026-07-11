/**
 * Kortix registry schema — a superset of the shadcn registry format.
 *
 * We deliberately track shadcn's `registry.json` / `registry-item.json`
 * shape (https://ui.shadcn.com/docs/registry) so that:
 *   - any Kortix repo is "just a registry" (drop a registry.json at the root),
 *   - tooling that already understands shadcn registries can read ours,
 *   - and we get namespaces / `include` / `registryDependencies` for free.
 *
 * What we add on top is a Kortix **item-type vocabulary** (skills, agents,
 * commands, tools, triggers, connectors, whole projects, bundles) and a set of
 * Kortix **target placeholders** (`@skills/…`, `@agents/…`, …). The install
 * mechanics are uniform: every item is ultimately a set of files copied to
 * `target` paths, exactly like shadcn's `registry:file`. The richer type is
 * metadata that drives categorization, icons, and validation.
 */

export const REGISTRY_SCHEMA_URL = 'https://ui.shadcn.com/schema/registry.json';
export const REGISTRY_ITEM_SCHEMA_URL = 'https://ui.shadcn.com/schema/registry-item.json';

/** shadcn's own item types — kept so plain files/components round-trip. */
export const SHADCN_ITEM_TYPES = [
  'registry:base',
  'registry:block',
  'registry:component',
  'registry:ui',
  'registry:lib',
  'registry:hook',
  'registry:page',
  'registry:file',
  'registry:style',
  'registry:theme',
  'registry:font',
  'registry:item',
] as const;

/** Kortix-native item types layered on top of the shadcn vocabulary. */
export const KORTIX_ITEM_TYPES = [
  'registry:skill', // an OpenCode SKILL.md (+ its reference files)
  'registry:agent', // an agent persona .md
  'registry:command', // an OpenCode slash command .md
  'registry:tool', // a custom OpenCode tool (.ts) or plugin
  'registry:trigger', // a kortix.yaml triggers: block (declarative)
  'registry:connector', // an integration definition (Pipedream/MCP/HTTP)
  'registry:rules', // AGENTS.md / rules files
  'registry:memory', // seed memory files
  'registry:project', // a whole Kortix project (full repo scaffold)
  'registry:bundle', // a curated set of other items (a "starter"/use-case)
  'registry:blueprint', // a skill + a PROPOSED (disabled) trigger — never auto-runs
] as const;

export const ALL_ITEM_TYPES = [...SHADCN_ITEM_TYPES, ...KORTIX_ITEM_TYPES] as const;

export type ShadcnItemType = (typeof SHADCN_ITEM_TYPES)[number];
export type KortixItemType = (typeof KORTIX_ITEM_TYPES)[number];
export type RegistryItemType = (typeof ALL_ITEM_TYPES)[number];

/** Item types that the Kortix gallery treats as first-class agent primitives. */
export const KORTIX_PRIMITIVE_TYPES: readonly KortixItemType[] = [
  'registry:skill',
  'registry:agent',
  'registry:command',
  'registry:tool',
  'registry:trigger',
  'registry:connector',
];

/**
 * Target placeholders. A file's `target` may start with one of these aliases;
 * the installer expands it against the consuming project's resolved layout
 * (the OpenCode config dir comes from `opencode.config_dir` in kortix.yaml,
 * defaulting to `.kortix/opencode`).
 *
 *   ~/<path>            → repo root, relative                (shadcn-compatible)
 *   @opencode/<path>    → <configDir>/<path>
 *   @skills/<path>      → <configDir>/skills/<path>
 *   @agents/<path>      → <configDir>/agents/<path>
 *   @commands/<path>    → <configDir>/commands/<path>
 *   @tools/<path>       → <configDir>/tools/<path>
 *   @memory/<path>      → .kortix/memory/<path>
 *   <relative path>     → repo root, relative                (no alias)
 */
export const TARGET_ALIASES = [
  '~',
  '@opencode',
  '@skills',
  '@agents',
  '@commands',
  '@tools',
  '@memory',
] as const;
export type TargetAlias = (typeof TARGET_ALIASES)[number];

export interface RegistryItemFile {
  /** Source path of the file, relative to the registry that declares it. */
  path: string;
  /** Per-file type (usually `registry:file`). */
  type: RegistryItemType;
  /**
   * Destination in the consuming project. Required for file-shaped items.
   * Supports the `TARGET_ALIASES` above. When omitted, the installer derives
   * a sensible default from the item type + source path.
   */
  target?: string;
  /**
   * Inline content. When present the installer writes this verbatim and does
   * not fetch `path` from the source — lets a registry ship a tiny item
   * without a separate file (and lets the API serve fully-resolved items).
   */
  content?: string;
}

/**
 * A blueprint's proposed automation. Installed as a DISABLED trigger in the
 * project's kortix.yaml — the human enables it later from the Triggers surface.
 */
export interface BlueprintProposedTrigger {
  /** Base slug — uniquified against the project's existing trigger slugs. */
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  /** Agent name (default: "default"). */
  agent?: string;
  /** cron only: 6-field croner expression (mutually exclusive with runAt). */
  cron?: string;
  /** cron only: ISO-8601 one-off instant. */
  runAt?: string;
  /** cron only: IANA timezone (default UTC). */
  timezone?: string;
  /** webhook only: the project_secrets key holding the HMAC signing secret. */
  secretEnv?: string;
  /** Prompt body; may reference {{slots.<name>}} placeholders. */
  promptTemplate: string;
}

export interface RegistryItem {
  $schema?: string;
  /** Unique slug within the registry. */
  name: string;
  type: RegistryItemType;
  /** Human title (defaults to `name`). */
  title?: string;
  description?: string;
  author?: string;
  /** npm packages the item needs (added to the project's tool package.json). */
  dependencies?: string[];
  devDependencies?: string[];
  /**
   * Other registry items this item needs. Each entry is an item address:
   *   "deep-research"                  (same registry)
   *   "@kortix/web-search"             (a namespaced registry)
   *   "kortix-ai/skills/pdf"           (a GitHub registry item)
   *   "https://host/r/editor.json"     (a direct item URL)
   */
  registryDependencies?: string[];
  /** Files to materialize. */
  files?: RegistryItemFile[];
  /** Env vars the item needs (surfaced as required secrets on install). */
  envVars?: Record<string, string>;
  /** Free-form categorization for the gallery. */
  categories?: string[];
  /** Install-time documentation shown to the user. */
  docs?: string;
  /**
   * Arbitrary metadata. Kortix reads:
   *   icon         — gallery icon id/url
   *   source       — provenance ("kortix-ai/skills")
   *   homepage     — link
   *   visibility   — "global" | "company" | "repo" (gallery scoping hint)
   */
  meta?: Record<string, unknown>;
  /**
   * registry:blueprint only. Installed as a DISABLED trigger appended to the
   * project's kortix.yaml — the installer forces enabled:false regardless of
   * this content, so a blueprint can never install as a live automation.
   */
  proposedTrigger?: BlueprintProposedTrigger;
  /**
   * registry:blueprint only. Slot params substituted into
   * proposedTrigger.promptTemplate ({{slots.<key>}}) at install time; a
   * provided value wins, otherwise the default is used.
   */
  slots?: Record<string, { label?: string; default: string }>;
}

export interface RegistryJson {
  $schema?: string;
  /** Registry identifier (used as a namespace, e.g. `@acme`). */
  name: string;
  /** Public homepage of the registry. */
  homepage?: string;
  /** Items declared inline. */
  items?: RegistryItem[];
  /**
   * Compose multiple registry.json files. Paths are relative to the file that
   * declares them; nested files contribute their items to the root registry.
   */
  include?: string[];
}

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

export interface RegistryLockEntry {
  /** The Kortix item type at install time. */
  type: RegistryItemType;
  /** The address the item was installed from. */
  source: string;
  /** "github" | "url" | "local" | "registry". */
  sourceType: RegistryLockSourceType;
  /** The files written, with a content hash for drift detection. */
  files: Array<{ target: string; hash: string }>;
  /** ISO timestamp; supplied by the caller (the engine never reads the clock). */
  installedAt?: string;
}

export type RegistryLockSourceType = 'github' | 'url' | 'local' | 'registry';

export interface RegistryLock {
  version: 2;
  items: Record<string, RegistryLockEntry>;
}

export const REGISTRY_LOCK_FILENAME = 'registry-lock.json';
/** Legacy lock we still read for back-compat (skills only). */
export const LEGACY_SKILLS_LOCK_FILENAME = 'skills-lock.json';
