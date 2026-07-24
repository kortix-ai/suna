/**
 * Writing a profile into project memory.
 *
 * Company memory is markdown in the project's git repo, and `MEMORY.md` is an
 * index — one line per sub-file, by the memory system's own convention. So a
 * profile lands as its own file under `.kortix/memory/enrichment/` and earns a
 * single line in the index, rather than being pasted into the index itself.
 * That keeps the file agents read first short, and it means re-enriching a
 * domain rewrites one self-contained file instead of editing around whatever
 * else has accumulated.
 *
 * Both writes are idempotent, because enrichment is expected to run again for
 * the same domain: the profile file is replaced wholesale, and the index line
 * is matched on its link target so a second run updates in place instead of
 * appending a duplicate.
 *
 * Order matters. The profile is committed first and the index second, so an
 * interruption leaves an unreferenced file (harmless, and fixed by the next
 * run) rather than an index pointing at a file that does not exist.
 */
import type { CompanyProfile, ProfileProvenance } from '../schemas';

export const MEMORY_DIR = '.kortix/memory';
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/MEMORY.md`;
export const ENRICHMENT_SUBDIR = 'enrichment';
export const INDEX_HEADING = '## Enriched companies';

const MAX_COMMIT_ATTEMPTS = 3;

export interface MemoryPort {
  /** Returns null when the file does not exist yet. */
  read(path: string): Promise<string | null>;
  commit(path: string, content: string, message: string): Promise<void>;
}

export interface WriteProfileArgs {
  domain: string;
  profile: CompanyProfile;
  provenance: ProfileProvenance;
}

export interface WriteProfileResult {
  profilePath: string;
  indexPath: string;
}

export function profileRelativePath(domain: string): string {
  return `${ENRICHMENT_SUBDIR}/${domain}.md`;
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

function indexLineFor(domain: string, profile: CompanyProfile): string {
  const summary = profile.tagline?.trim() || profile.description?.trim()?.split('\n')[0] || null;
  const label = profile.name?.trim() || domain;
  const link = `- [${label}](${profileRelativePath(domain)})`;
  if (!summary) return link;
  const short = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
  return `${link} — ${short}`;
}

/**
 * Add or replace this domain's line in the index. The line is located by its
 * link target, which is stable across renames of the company itself, and the
 * section heading is created on first use.
 */
export function upsertIndexLine(
  existing: string | null,
  domain: string,
  profile: CompanyProfile,
): string {
  const line = indexLineFor(domain, profile);
  const target = `(${profileRelativePath(domain)})`;
  const base = existing ?? '# Project Memory\n';
  const lines = base.split('\n');

  const existingIndex = lines.findIndex((l) => l.includes(target));
  if (existingIndex >= 0) {
    lines[existingIndex] = line;
    return lines.join('\n');
  }

  const headingIndex = lines.findIndex((l) => l.trim() === INDEX_HEADING);
  if (headingIndex >= 0) {
    // Insert after the heading's existing entries so ordering stays stable.
    let insertAt = headingIndex + 1;
    while (insertAt < lines.length && (lines[insertAt].startsWith('- ') || !lines[insertAt].trim())) {
      if (lines[insertAt].startsWith('- ')) insertAt += 1;
      else if (insertAt + 1 < lines.length && lines[insertAt + 1].startsWith('- ')) insertAt += 1;
      else break;
    }
    lines.splice(insertAt, 0, line);
    return lines.join('\n');
  }

  const trimmed = base.replace(/\s+$/, '');
  return `${trimmed}\n\n${INDEX_HEADING}\n\n${line}\n`;
}

/**
 * Commit with a bounded retry. The underlying commit is compare-and-swap on
 * the branch tip with no retry of its own, so a concurrent write (another
 * enrichment, an agent editing memory) loses the race and must re-read before
 * trying again.
 */
async function commitWithRetry(
  port: MemoryPort,
  path: string,
  build: (current: string | null) => Promise<string> | string,
  message: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await port.read(path);
    const content = await build(current);
    try {
      await port.commit(path, content, message);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`failed to commit ${path} after ${MAX_COMMIT_ATTEMPTS} attempts`);
}

export async function writeProfileToMemory(
  port: MemoryPort,
  args: WriteProfileArgs,
): Promise<WriteProfileResult> {
  const profilePath = profileRepoPath(args.domain);
  const rendered = renderProfileMarkdown(args.profile, args.provenance);

  await commitWithRetry(
    port,
    profilePath,
    () => rendered,
    `memory: enrich ${args.domain}`,
  );

  await commitWithRetry(
    port,
    MEMORY_INDEX_PATH,
    (current) => upsertIndexLine(current, args.domain, args.profile),
    `memory: index ${args.domain}`,
  );

  return { profilePath, indexPath: MEMORY_INDEX_PATH };
}
