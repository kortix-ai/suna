/**
 * Writing enrichment output into project memory.
 *
 * Memory is markdown in the project's git repo. The original version
 * distilled a whole crawl into one profile file, which meant every fetched
 * page was thrown away the moment the model finished with it — the actual
 * pricing table, the actual team bios, were gone the instant the summary
 * landed. Now each domain gets its own folder under
 * `.kortix/memory/enrichment/`: `profile.md` for the rendered/validated
 * summary, `pages/<slug>.md` for every other page's cleaned content, and
 * `blog/<slug>.md` for posts — kept separate because a blog is read
 * differently than a landing page (chronological, many of them, low signal
 * per post) and deserves its own shelf rather than diluting `pages/`.
 *
 * `MEMORY.md` stays the index every agent reads first, so it has to earn that
 * role by pointing at everything, not just the profile: a domain gets a
 * parent bullet plus one nested bullet per generated file. That is the
 * point of this module — an index that lists a profile but silently drops
 * forty crawled pages is not actually an index.
 *
 * The whole write — every file in the folder, the stale-file deletes, and
 * the index update — lands as ONE commit. Splitting it across several
 * commits (as the single-file version did, profile then index) would let a
 * crash between them leave memory half-updated: new pages present but the
 * index not yet pointing at them, or a page deleted from the index but not
 * from disk. One commit makes that failure mode impossible — an
 * interruption leaves the previous commit fully intact rather than a folder
 * in a state nothing ever asked for.
 *
 * Idempotent by construction: re-running a domain replaces its whole block in
 * the index (matched on the domain itself, since the profile is no longer
 * the block's sole link target) and its whole set of files. Whatever
 * page/blog files existed under the domain's folder before but are not
 * produced by this run are deleted in the same commit — a page that vanished
 * from the site must not linger in memory forever.
 *
 * `pages`/`blogPosts` are each optional independently of the other, and the
 * distinction between "omitted" and "explicitly empty" is load-bearing: a
 * cache-hit re-enrichment (see `worker.ts`) never re-crawls, so it has no
 * opinion on the page set and must omit the field entirely — that leaves the
 * previously-written files and their index bullets untouched. Passing `[]`
 * instead means "I crawled and confirmed there is nothing here," which does
 * delete whatever was previously recorded. Collapsing the two (e.g. via `??
 * []`) would make every cache-hit run silently wipe all previously crawled
 * page/blog content.
 */
import type { CompanyProfile, ProfileProvenance } from '../schemas';
import type { PageFetchTier } from './page-fetch';

export const MEMORY_DIR = '.kortix/memory';
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/MEMORY.md`;
export const ENRICHMENT_SUBDIR = 'enrichment';
export const INDEX_HEADING = '## Enriched companies';

const MAX_COMMIT_ATTEMPTS = 3;
const MAX_SLUG_LENGTH = 80;

export interface MemoryPort {
  /** Returns null when the file does not exist yet. */
  read(path: string): Promise<string | null>;
  /**
   * Write and delete a set of files in one atomic commit. Widened from a
   * single-file `commit` because a domain write now touches a whole folder
   * plus the index, and those must never land as separate commits (see
   * module header).
   */
  commitMany(args: {
    files: Array<{ path: string; content: string }>;
    deletes: string[];
    message: string;
  }): Promise<void>;
}

/** A page (or blog post) fetched during the crawl, as produced by `fetchPages`. */
export interface MemoryPageContent {
  url: string;
  markdown: string;
  tier: PageFetchTier;
}

export interface WriteProfileArgs {
  domain: string;
  profile: CompanyProfile;
  provenance: ProfileProvenance;
  /** Non-blog pages, written under `pages/`. */
  pages?: MemoryPageContent[];
  /** Pages whose url-filter tier is `blog`, written under `blog/`. */
  blogPosts?: MemoryPageContent[];
}

export interface WriteProfileResult {
  profilePath: string;
  indexPath: string;
  pagePaths: string[];
  blogPaths: string[];
}

export function domainRelativeDir(domain: string): string {
  return `${ENRICHMENT_SUBDIR}/${domain}`;
}

export function profileRelativePath(domain: string): string {
  return `${domainRelativeDir(domain)}/profile.md`;
}

export function profileRepoPath(domain: string): string {
  return `${MEMORY_DIR}/${profileRelativePath(domain)}`;
}

function bullet(label: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `- **${label}:** ${trimmed}` : null;
}

/**
 * Render the profile as a document a person would want to read, with the
 * validated JSON appended for agents and for re-processing. Empty sections are
 * omitted rather than rendered as headings with nothing under them.
 */
export function renderProfileMarkdown(
  profile: CompanyProfile,
  provenance: ProfileProvenance,
): string {
  const out: string[] = [];
  const title = profile.name?.trim() || provenance.domain;

  out.push(`# ${title}`, '');
  // `tagline` and `headline` are the same "one-line pitch" role for a company
  // and a person respectively; a profile only ever fills in the one that
  // matches its subject, so falling back keeps the subtitle from going blank
  // just because the subject wasn't a company.
  const subtitle = profile.tagline || profile.headline;
  if (subtitle) out.push(`_${subtitle}_`, '');

  const facts = [
    bullet('Domain', provenance.domain),
    bullet('Crawled', provenance.crawledAt),
    bullet('Crawl status', provenance.crawlStatus),
  ].filter((line): line is string => line !== null);
  out.push(...facts, '');

  if (provenance.crawlStatus === 'partial') {
    out.push(
      '> This profile is partial — parts of the site could not be read, so sections may be missing.',
      '',
    );
  }

  const overview = profile.description || profile.bio;
  if (overview) out.push('## Overview', '', overview, '');

  if (profile.positioning) out.push('## Positioning', '', profile.positioning, '');

  if (profile.keyFacts.length > 0) {
    out.push('## Key facts', '');
    for (const fact of profile.keyFacts) out.push(`- **${fact.label}:** ${fact.value}`);
    out.push('');
  }

  if (profile.products.length > 0) {
    out.push('## Products', '');
    for (const product of profile.products) {
      const heading = product.url ? `[${product.name}](${product.url})` : product.name;
      out.push(product.description ? `- **${heading}** — ${product.description}` : `- **${heading}**`);
    }
    out.push('');
  }

  if (profile.pricingSummary) out.push('## Pricing', '', profile.pricingSummary, '');

  if (profile.team.length > 0) {
    out.push('## Team', '');
    for (const member of profile.team) {
      const name = member.link ? `[${member.name}](${member.link})` : member.name;
      out.push(member.role ? `- ${name} — ${member.role}` : `- ${name}`);
    }
    out.push('');
  }

  if (profile.roles.length > 0) {
    out.push('## Experience', '');
    for (const role of profile.roles) {
      const span = [role.start, role.end].filter((part): part is string => Boolean(part)).join(' – ');
      const where = role.org ? ` at ${role.org}` : '';
      const when = span ? ` (${span})` : '';
      const heading = `- **${role.title}**${where}${when}`;
      out.push(role.summary ? `${heading} — ${role.summary}` : heading);
    }
    out.push('');
  }

  if (profile.projects.length > 0) {
    out.push('## Projects', '');
    for (const project of profile.projects) {
      const heading = project.url ? `[${project.name}](${project.url})` : project.name;
      out.push(project.description ? `- **${heading}** — ${project.description}` : `- **${heading}**`);
    }
    out.push('');
  }

  const contactLines = [
    bullet('Email', profile.contact.email),
    bullet('Phone', profile.contact.phone),
    bullet('Address', profile.contact.address),
  ].filter((line): line is string => line !== null);
  if (contactLines.length > 0) out.push('## Contact', '', ...contactLines, '');

  if (profile.socials.length > 0) {
    out.push('## Social', '');
    for (const social of profile.socials) out.push(`- ${social.platform}: ${social.url}`);
    out.push('');
  }

  if (profile.blogPosts.length > 0) {
    out.push('## Recent posts', '');
    for (const post of profile.blogPosts) {
      out.push(post.date ? `- [${post.title}](${post.url}) — ${post.date}` : `- [${post.title}](${post.url})`);
    }
    out.push('');
  }

  out.push('## Sources', '');
  for (const source of profile.sources) out.push(`- ${source}`);
  out.push('');

  out.push(
    '## Structured profile',
    '',
    `Extracted by \`${provenance.model}\`. Every field above traces to a source URL listed here.`,
    '',
    '```json',
    JSON.stringify(profile, null, 2),
    '```',
    '',
  );

  return out.join('\n');
}

/**
 * Slug for a page's file name: the URL's path, lowercased, non-alphanumerics
 * collapsed to a single `-`. The path (not the full URL) is enough to be
 * readable and stays stable across the http/https and www-vs-not variants
 * `normalizeUrl` already folds together upstream. The root path has no
 * alphanumeric content of its own, so it falls back to `index`.
 */
export function slugForUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const collapsed = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = (collapsed || 'index').slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  return base || 'index';
}

/**
 * Assigns a stable slug per item, deduping collisions with a numeric suffix.
 * The suffix is reserved for before the base is capped rather than appended
 * and then re-sliced — two different URLs whose base slug both already sit
 * at `MAX_SLUG_LENGTH` would otherwise have their suffix sliced straight back
 * off, leaving both items with the identical base slug and one file silently
 * overwriting the other.
 */
function withDedupedSlugs<T extends { url: string }>(items: T[]): Array<T & { slug: string }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = slugForUrl(item.url);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count === 1) return { ...item, slug: base };
    const suffix = `-${count}`;
    const trimmedBase = base.slice(0, Math.max(0, MAX_SLUG_LENGTH - suffix.length)).replace(/-+$/g, '');
    return { ...item, slug: `${trimmedBase || 'index'}${suffix}` };
  });
}

/** Cleaned page content as its own file, with just enough front matter to trace it back to the crawl. */
function renderPageMarkdown(page: MemoryPageContent, fetchedAt: string): string {
  return [
    '---',
    `source: "${page.url}"`,
    `fetchedAt: "${fetchedAt}"`,
    `tier: ${page.tier}`,
    '---',
    '',
    page.markdown.trim(),
    '',
  ].join('\n');
}

interface MemoryIndexEntry {
  /** Nested bullet's link text, e.g. `profile`, `pages/about`, `blog/launch`. */
  label: string;
  /** Relative to MEMORY_DIR, so links from MEMORY.md resolve correctly. */
  relativePath: string;
  summary?: string;
}

function truncateSummary(summary: string): string {
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function profileEntry(domain: string, profile: CompanyProfile): MemoryIndexEntry {
  const raw = profile.tagline?.trim() || profile.description?.trim()?.split('\n')[0] || undefined;
  return {
    label: 'profile',
    relativePath: profileRelativePath(domain),
    summary: raw ? truncateSummary(raw) : undefined,
  };
}

function contentFiles(
  domain: string,
  kind: 'pages' | 'blog',
  items: MemoryPageContent[],
  fetchedAt: string,
): { files: Array<{ path: string; content: string }>; entries: MemoryIndexEntry[] } {
  const files: Array<{ path: string; content: string }> = [];
  const entries: MemoryIndexEntry[] = [];
  for (const item of withDedupedSlugs(items)) {
    const relativePath = `${domainRelativeDir(domain)}/${kind}/${item.slug}.md`;
    files.push({ path: `${MEMORY_DIR}/${relativePath}`, content: renderPageMarkdown(item, fetchedAt) });
    entries.push({ label: `${kind}/${item.slug}`, relativePath });
  }
  return { files, entries };
}

function nestedBulletLine(entry: MemoryIndexEntry): string {
  const link = `[${entry.label}](${entry.relativePath})`;
  return entry.summary ? `  - ${link} — ${entry.summary}` : `  - ${link}`;
}

function domainParentPrefix(domain: string): string {
  return `- **${domain}**`;
}

/** Which generated-file category a nested bullet's link target belongs to, for reconciliation. */
function categoryForRelativePath(domain: string, relativePath: string): 'pages' | 'blog' | 'other' {
  const dir = domainRelativeDir(domain);
  if (relativePath.startsWith(`${dir}/pages/`)) return 'pages';
  if (relativePath.startsWith(`${dir}/blog/`)) return 'blog';
  return 'other';
}

const TOP_BULLET_RE = /^- /;
const NESTED_BULLET_RE = /^ {2}- /;
const LINK_TARGET_RE = /\(([^)]+)\)/;
const TOP_LEVEL_HEADING_RE = /^## /;

/**
 * Locates the `## Enriched companies` heading and the next top-level heading
 * (or EOF), and only looks for the domain's parent bullet within that span.
 * An unbounded whole-file search would misidentify any line elsewhere in an
 * agent-maintained MEMORY.md that happens to start with the same
 * `- **<domain>**` prefix — e.g. a note the agent wrote about the domain
 * outside the index section — as the block to splice over, deleting its
 * following indented lines as if they were stale generated files.
 */
function findDomainBlock(lines: string[], parentPrefix: string): { start: number; end: number } | null {
  const headingIndex = lines.findIndex((l) => l.trim() === INDEX_HEADING);
  if (headingIndex < 0) return null;

  let sectionEndIdx = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_HEADING_RE.test(lines[i])) {
      sectionEndIdx = i;
      break;
    }
  }

  let start = -1;
  for (let i = headingIndex + 1; i < sectionEndIdx; i += 1) {
    if (lines[i].startsWith(parentPrefix)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let end = start + 1;
  while (end < sectionEndIdx && NESTED_BULLET_RE.test(lines[end])) end += 1;
  return { start, end };
}

/** End of the section's bullet run, right after the heading and its optional blank line. */
function sectionEnd(lines: string[], headingIndex: number): number {
  let i = headingIndex + 1;
  if (i < lines.length && !lines[i].trim()) i += 1;
  while (i < lines.length && (TOP_BULLET_RE.test(lines[i]) || NESTED_BULLET_RE.test(lines[i]))) i += 1;
  return i;
}

/**
 * Replace this domain's whole block — the parent line plus a nested bullet
 * for every generated file — so MEMORY.md alone lists everything available
 * for the domain. The block is matched on the domain itself (not on the
 * profile's link, since the profile is now just one of several nested
 * entries).
 *
 * `preserve` names the categories (`pages`/`blog`) this run has no opinion on
 * — the caller omitted that field entirely rather than confirming it empty —
 * so their existing nested bullets are carried over verbatim into the new
 * block instead of being diffed against `entries` at all. Every other
 * previously-listed nested path that the new block does not repeat is
 * genuinely stale and returned for the caller to delete in the same commit.
 */
function upsertIndexBlock(
  existing: string | null,
  domain: string,
  entries: MemoryIndexEntry[],
  preserve: ReadonlySet<'pages' | 'blog'>,
): { content: string; stalePaths: string[] } {
  const parentPrefix = domainParentPrefix(domain);
  const base = existing ?? '# Project Memory\n';
  const lines = base.split('\n');
  const newRelPaths = new Set(entries.map((e) => e.relativePath));

  const found = findDomainBlock(lines, parentPrefix);
  if (found) {
    const stalePaths: string[] = [];
    const keptLines: string[] = [];
    for (let i = found.start + 1; i < found.end; i += 1) {
      const match = lines[i].match(LINK_TARGET_RE);
      if (!match || newRelPaths.has(match[1])) continue;
      const category = categoryForRelativePath(domain, match[1]);
      if (category !== 'other' && preserve.has(category)) {
        keptLines.push(lines[i]);
      } else {
        stalePaths.push(`${MEMORY_DIR}/${match[1]}`);
      }
    }
    const block = [parentPrefix, ...entries.map(nestedBulletLine), ...keptLines];
    lines.splice(found.start, found.end - found.start, ...block);
    return { content: lines.join('\n'), stalePaths };
  }

  // No existing block for this domain, so there is nothing to preserve —
  // `preserve` only ever matters when reconciling against prior nested lines.
  const freshBlock = [parentPrefix, ...entries.map(nestedBulletLine)];

  const headingIndex = lines.findIndex((l) => l.trim() === INDEX_HEADING);
  if (headingIndex >= 0) {
    lines.splice(sectionEnd(lines, headingIndex), 0, ...freshBlock);
    return { content: lines.join('\n'), stalePaths: [] };
  }

  const trimmed = base.replace(/\s+$/, '');
  return { content: `${trimmed}\n\n${INDEX_HEADING}\n\n${freshBlock.join('\n')}\n`, stalePaths: [] };
}

/**
 * Commit with a bounded retry. `commitMany` is compare-and-swap on the branch
 * tip with no retry of its own, so a concurrent write (another enrichment, an
 * agent editing memory) loses the race and must re-read the index before
 * trying again — the file contents don't depend on the index, only the
 * index's own merge does, so only it needs re-reading per attempt.
 */
async function commitDomainWithRetry(
  port: MemoryPort,
  domain: string,
  files: Array<{ path: string; content: string }>,
  entries: MemoryIndexEntry[],
  preserve: ReadonlySet<'pages' | 'blog'>,
  message: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const currentIndex = await port.read(MEMORY_INDEX_PATH);
    const { content: indexContent, stalePaths } = upsertIndexBlock(currentIndex, domain, entries, preserve);
    try {
      await port.commitMany({
        files: [...files, { path: MEMORY_INDEX_PATH, content: indexContent }],
        deletes: stalePaths,
        message,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`failed to commit memory for ${domain} after ${MAX_COMMIT_ATTEMPTS} attempts`);
}

export async function writeProfileToMemory(
  port: MemoryPort,
  args: WriteProfileArgs,
): Promise<WriteProfileResult> {
  const { domain, profile, provenance } = args;
  const profilePath = profileRepoPath(domain);

  const files: Array<{ path: string; content: string }> = [
    { path: profilePath, content: renderProfileMarkdown(profile, provenance) },
  ];
  const entries: MemoryIndexEntry[] = [profileEntry(domain, profile)];
  const preserve = new Set<'pages' | 'blog'>();

  let pagePaths: string[] = [];
  if (args.pages === undefined) {
    preserve.add('pages');
  } else {
    const pagesBuilt = contentFiles(domain, 'pages', args.pages, provenance.crawledAt);
    files.push(...pagesBuilt.files);
    entries.push(...pagesBuilt.entries);
    pagePaths = pagesBuilt.files.map((f) => f.path);
  }

  let blogPaths: string[] = [];
  if (args.blogPosts === undefined) {
    preserve.add('blog');
  } else {
    const blogBuilt = contentFiles(domain, 'blog', args.blogPosts, provenance.crawledAt);
    files.push(...blogBuilt.files);
    entries.push(...blogBuilt.entries);
    blogPaths = blogBuilt.files.map((f) => f.path);
  }

  await commitDomainWithRetry(port, domain, files, entries, preserve, `memory: enrich ${domain}`);

  return {
    profilePath,
    indexPath: MEMORY_INDEX_PATH,
    pagePaths,
    blogPaths,
  };
}
