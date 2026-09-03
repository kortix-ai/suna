/**
 * The sandbox-facing envelope for a manifest `subprojects.<slug>` block
 * (spec docs/specs/2026-09-03-subprojects.md §7).
 *
 * A subproject's identity, standing instructions and context paths are declared
 * in the manifest, but the sandbox has no manifest reader — it receives them as
 * two server-owned environment variables and the daemon renders them into an
 * OpenCode `instructions` file (apps/kortix-sandbox-agent-server/src/subproject.ts).
 *
 * Everything here except `loadSubprojectEnvelopeForSession` is pure, so the
 * size caps and the `context` → OpenCode-instructions mapping are testable
 * without git.
 */
import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  type ManifestV2,
  type SubprojectBlockV2,
  type SubprojectSessionsModeV2,
} from '@kortix/manifest-schema';
import { readManifestFromRepo, type GitBackedProject } from '../git';

/** The subproject slug a session runs inside. Empty/absent for a plain session. */
export const SUBPROJECT_ENV_NAME = 'KORTIX_SUBPROJECT';
/** The JSON envelope below. Written only alongside SUBPROJECT_ENV_NAME. */
export const SUBPROJECT_CONTEXT_ENV_NAME = 'KORTIX_SUBPROJECT_CONTEXT';

/** Instructions are author-controlled free text; cap them well below the env cap. */
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
/** Linux MAX_ARG_STRLEN is 128 KB per variable; stay a comfortable half of it. */
const MAX_ENVELOPE_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = '\n…[truncated]';

export interface SubprojectEnvelope {
  version: 1;
  slug: string;
  /** Defaults to the slug when the block declares no name. */
  name: string;
  description: string | null;
  instructions: string | null;
  context: string[];
  sessions: SubprojectSessionsModeV2;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncate to a UTF-8 byte budget INCLUDING the suffix. Slicing a Buffer can
 * split a multi-byte character; `toString` renders the remainder as U+FFFD, so
 * strip a trailing run of them rather than shipping mojibake.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const room = maxBytes - byteLength(TRUNCATION_SUFFIX);
  if (room <= 0) return '';
  return (
    Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '') +
    TRUNCATION_SUFFIX
  );
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Build the envelope for one declared block. Pure. */
export function buildSubprojectEnvelope(
  slug: string,
  block: SubprojectBlockV2,
): SubprojectEnvelope {
  return {
    version: 1,
    slug,
    name: trimmedOrNull(block.name) ?? slug,
    description: trimmedOrNull(block.description),
    instructions: trimmedOrNull(block.instructions),
    context: Array.isArray(block.context)
      ? block.context.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
      : [],
    sessions: block.sessions === 'shared' ? 'shared' : 'private',
  };
}

/**
 * The two env vars a session inside a subproject carries. `null` ⇒ `{}`, so a
 * plain session's sandbox env is byte-for-byte what it was before subprojects.
 *
 * Shrinking is a fixed three-step ladder, not a loop: cap `instructions` at
 * 32 KB, then shave whatever still overflows 64 KB off `instructions`, then
 * drop `context`. JSON escaping means each step removes at least as many bytes
 * as it is asked to, so the ladder terminates.
 */
export function subprojectEnvelopeEnv(
  envelope: SubprojectEnvelope | null | undefined,
): Record<string, string> {
  if (!envelope) return {};
  const capped: SubprojectEnvelope = {
    ...envelope,
    instructions: envelope.instructions
      ? truncateUtf8(envelope.instructions, MAX_INSTRUCTIONS_BYTES)
      : envelope.instructions,
  };

  let json = JSON.stringify(capped);
  if (byteLength(json) > MAX_ENVELOPE_BYTES && capped.instructions) {
    const overflow = byteLength(json) - MAX_ENVELOPE_BYTES;
    capped.instructions =
      truncateUtf8(capped.instructions, byteLength(capped.instructions) - overflow) || null;
    json = JSON.stringify(capped);
  }
  if (byteLength(json) > MAX_ENVELOPE_BYTES) {
    capped.context = [];
    json = JSON.stringify(capped);
  }
  if (byteLength(json) > MAX_ENVELOPE_BYTES) {
    // Only reachable with an absurd name/description. The slug alone still
    // reaches the sandbox: `kortix sessions new` inheritance keeps working.
    console.warn('[subproject] envelope exceeds the env cap; sending the slug only', {
      slug: envelope.slug,
    });
    return { [SUBPROJECT_ENV_NAME]: envelope.slug };
  }
  return {
    [SUBPROJECT_ENV_NAME]: envelope.slug,
    [SUBPROJECT_CONTEXT_ENV_NAME]: json,
  };
}

/**
 * The subproject's `context[]` as OpenCode top-level `instructions` entries.
 * OpenCode inlines a file path natively and expands a glob, so a directory
 * entry (trailing slash) becomes `dir/**\/*.md` and a file passes through.
 * De-duplicated, order preserved.
 */
export function subprojectContextInstructions(context: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of context) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;
    const mapped = entry.endsWith('/') ? `${entry}**/*.md` : entry;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** Pick one declared block out of an already-parsed manifest. Pure. */
export function subprojectBlockFromManifest(
  manifest: Record<string, unknown>,
  slug: string | null | undefined,
): SubprojectBlockV2 | null {
  if (!slug) return null;
  const map = (manifest as unknown as ManifestV2).subprojects;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const block = (map as Record<string, SubprojectBlockV2>)[slug];
  return block && typeof block === 'object' && !Array.isArray(block) ? block : null;
}

/**
 * Read the project's manifest at the session's ref and build the envelope.
 *
 * Never throws and never blocks a boot: an undeclared slug, a v1 manifest or an
 * unreadable repo all resolve to `null` (warned), and the session starts without
 * the envelope. Authoring errors surface at `kortix validate` time, not by
 * failing a session months later — the same posture as
 * `resolveCompiledAgentConfigForSession`.
 */
export async function loadSubprojectEnvelopeForSession(
  project: GitBackedProject,
  slug: string | null | undefined,
  baseRef?: string | null,
): Promise<SubprojectEnvelope | null> {
  if (!slug) return null;
  const ref = baseRef?.trim() || project.defaultBranch;
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    const found = await readManifestFromRepo(project, candidates, ref);
    if (!found) return null;
    const raw = parseManifestText(found.content, manifestFormatForPath(found.path));
    const block = subprojectBlockFromManifest(raw, slug);
    if (!block) {
      console.warn(
        `[subproject] project ${project.projectId}: session subproject "${slug}" is not declared at ${ref}; booting without it`,
      );
      return null;
    }
    return buildSubprojectEnvelope(slug, block);
  } catch (err) {
    console.warn(
      `[subproject] project ${project.projectId}: could not resolve subproject "${slug}": ${(err as Error).message}`,
    );
    return null;
  }
}
