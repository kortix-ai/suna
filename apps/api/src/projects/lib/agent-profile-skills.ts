import { posix } from 'node:path';
import { SLUG_RE } from '@kortix/manifest-schema';
import JSZip, { type JSZipObject } from 'jszip';
import { parse as parseYaml } from 'yaml';

export const AGENT_SKILL_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
export const AGENT_SKILL_EXPANDED_MAX_BYTES = 20 * 1024 * 1024;
export const AGENT_SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_SKILL_FILE_MAX_COUNT = 100;
const AGENT_SKILL_ENTRY_MAX_COUNT = AGENT_SKILL_FILE_MAX_COUNT * 2;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

export interface AgentProfileSkillFile {
  path: string;
  content: string;
}

export interface ValidatedAgentSkill {
  slug: string;
  name: string;
  description: string;
  files: AgentProfileSkillFile[];
}

interface ZipEntryMetadata {
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

type ZipObjectWithMetadata = JSZipObject & {
  _data?: Partial<ZipEntryMetadata>;
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export class AgentSkillImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillImportError';
  }
}

function safeArchivePath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new AgentSkillImportError(
      'skill_archive_traversal',
      'Skill archive contains an unsafe path.',
    );
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new AgentSkillImportError(
      'skill_archive_traversal',
      'Skill archive contains path traversal.',
    );
  }
  return normalized.replace(/\/+$/, '');
}

function symlink(entry: JSZipObject): boolean {
  const raw = entry.unixPermissions;
  const permissions =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 8) : 0;
  return (permissions & 0o170000) === 0o120000;
}

function zipEntryMetadata(entry: JSZipObject, path: string): ZipEntryMetadata {
  const metadata = (entry as ZipObjectWithMetadata)._data;
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.compressedSize) ||
    !Number.isSafeInteger(metadata.uncompressedSize) ||
    !Number.isInteger(metadata.crc32) ||
    (metadata.compressedSize ?? -1) < 0 ||
    (metadata.uncompressedSize ?? -1) < 0
  ) {
    throw new AgentSkillImportError(
      'skill_archive_invalid',
      `${path} has invalid ZIP size or checksum metadata.`,
    );
  }
  return metadata as ZipEntryMetadata;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = (CRC_TABLE[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function readBoundedZipEntry(
  entry: JSZipObject,
  path: string,
  maxBytes: number,
  limitError: AgentSkillImportError,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = (entry as ZipObjectWithMetadata).internalStream('uint8array');
    let size = 0;
    let settled = false;

    const fail = (error: AgentSkillImportError) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };

    stream
      .on('data', (chunk) => {
        if (settled) return;
        size += chunk.byteLength;
        if (size > maxBytes) {
          fail(limitError);
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        fail(
          new AgentSkillImportError(
            'skill_archive_invalid',
            `${path} could not be decompressed: ${error.message}`,
          ),
        );
      })
      .on('end', () => {
        if (settled) return;
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        settled = true;
        resolve(body);
      })
      .resume();
  });
}

function preflightZipDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstOffset = Math.max(0, bytes.byteLength - ZIP_END_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bytes.byteLength - ZIP_END_MIN_BYTES; offset >= firstOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + ZIP_END_MIN_BYTES + commentBytes !== bytes.byteLength) continue;
    const diskNumber = view.getUint16(offset + 4, true);
    const directoryDisk = view.getUint16(offset + 6, true);
    const entriesOnDisk = view.getUint16(offset + 8, true);
    const totalEntries = view.getUint16(offset + 10, true);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new AgentSkillImportError(
        'skill_archive_invalid',
        'Multi-disk skill archives are not supported.',
      );
    }
    if (totalEntries === 0xffff || totalEntries > AGENT_SKILL_ENTRY_MAX_COUNT) {
      throw new AgentSkillImportError(
        'skill_archive_file_count',
        `Skill archives cannot contain more than ${AGENT_SKILL_ENTRY_MAX_COUNT} total entries.`,
      );
    }
    return;
  }
  throw new AgentSkillImportError(
    'skill_archive_invalid',
    'Skill archive has no valid ZIP central directory.',
  );
}

function parseSkillFrontmatter(content: string, path: string) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(content);
  if (!match) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} must start with YAML frontmatter containing name and description.`,
    );
  }
  const frontmatterText = match[1];
  if (frontmatterText === undefined) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} must contain YAML frontmatter content.`,
    );
  }
  let value: unknown;
  try {
    value = parseYaml(frontmatterText);
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter must be an object.`,
    );
  }
  const frontmatter = value as Record<string, unknown>;
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!SLUG_RE.test(name)) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter name must be a lowercase skill slug.`,
    );
  }
  if (!description || description.length > 4000) {
    throw new AgentSkillImportError(
      'skill_frontmatter_invalid',
      `${path} frontmatter description must contain 1 to 4000 characters.`,
    );
  }
  return { name, description };
}

export function validateAgentSkillFiles(
  inputFiles: Array<{ path: string; content: string }>,
): ValidatedAgentSkill[] {
  if (inputFiles.length === 0 || inputFiles.length > AGENT_SKILL_FILE_MAX_COUNT) {
    throw new AgentSkillImportError(
      'skill_archive_file_count',
      `Skill archives must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
    );
  }
  let expandedBytes = 0;
  const files = inputFiles.map((input) => {
    const path = safeArchivePath(input.path);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${path} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += bytes;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
    return { path, content: input.content };
  });
  const skillFiles = files.filter((file) => posix.basename(file.path) === 'SKILL.md');
  if (skillFiles.length === 0) {
    throw new AgentSkillImportError(
      'skill_file_missing',
      'Skill archive must contain a SKILL.md file.',
    );
  }

  const slugs = new Set<string>();
  const roots = skillFiles.map((file) => ({
    file,
    root: posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path),
  }));
  return roots
    .map(({ file, root }) => {
      const metadata = parseSkillFrontmatter(file.content, file.path);
      if (slugs.has(metadata.name)) {
        throw new AgentSkillImportError(
          'skill_slug_duplicate',
          `Skill archive contains duplicate skill slug "${metadata.name}".`,
        );
      }
      slugs.add(metadata.name);
      const rootPrefix = root ? `${root}/` : '';
      const ownedFiles = files
        .filter((candidate) =>
          root ? candidate.path === file.path || candidate.path.startsWith(rootPrefix) : true,
        )
        .map((candidate) => {
          const relativePath = root ? candidate.path.slice(rootPrefix.length) : candidate.path;
          return {
            path: `.kortix/opencode/skills/${metadata.name}/${relativePath}`,
            content: candidate.content,
          };
        })
        .sort((left, right) => {
          const leftSkill = left.path.endsWith('/SKILL.md') ? 0 : 1;
          const rightSkill = right.path.endsWith('/SKILL.md') ? 0 : 1;
          return leftSkill - rightSkill || left.path.localeCompare(right.path);
        });
      return {
        slug: metadata.name,
        name: metadata.name,
        description: metadata.description,
        files: ownedFiles,
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function readAgentSkillArchive(bytes: Uint8Array): Promise<ValidatedAgentSkill[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > AGENT_SKILL_ARCHIVE_MAX_BYTES) {
    throw new AgentSkillImportError(
      'skill_archive_size',
      'Skill archive must contain 1 byte to 10 MB.',
    );
  }
  preflightZipDirectory(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: true });
  } catch (error) {
    throw new AgentSkillImportError(
      'skill_archive_invalid',
      `Skill archive is not a valid ZIP file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = Object.values(zip.files);
  const metadataByEntry = new Map<JSZipObject, ZipEntryMetadata>();
  let fileCount = 0;
  let declaredExpandedBytes = 0;
  for (const entry of entries) {
    const original =
      (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    safeArchivePath(original);
    if (symlink(entry)) {
      throw new AgentSkillImportError(
        'skill_archive_symlink',
        'Skill archives cannot contain symlinks.',
      );
    }
    if (entry.dir) continue;
    fileCount += 1;
    const path = safeArchivePath(entry.name);
    const metadata = zipEntryMetadata(entry, path);
    if (metadata.uncompressedSize > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${path} exceeds the 2 MB per-file limit.`,
      );
    }
    declaredExpandedBytes += metadata.uncompressedSize;
    if (declaredExpandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
    metadataByEntry.set(entry, metadata);
  }
  if (fileCount === 0 || fileCount > AGENT_SKILL_FILE_MAX_COUNT) {
    throw new AgentSkillImportError(
      'skill_archive_file_count',
      `Skill archives must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
    );
  }

  const files: Array<{ path: string; content: string }> = [];
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const path = safeArchivePath(entry.name);
    const remainingBytes = AGENT_SKILL_EXPANDED_MAX_BYTES - expandedBytes;
    const fileLimit = Math.min(AGENT_SKILL_FILE_MAX_BYTES, remainingBytes);
    const limitError =
      remainingBytes < AGENT_SKILL_FILE_MAX_BYTES
        ? new AgentSkillImportError(
            'skill_archive_too_large',
            'Expanded skill archive exceeds the 20 MB limit.',
          )
        : new AgentSkillImportError(
            'skill_archive_file_too_large',
            `${path} exceeds the 2 MB per-file limit.`,
          );
    const body = await readBoundedZipEntry(entry, path, fileLimit, limitError);
    const metadata = metadataByEntry.get(entry);
    if (
      !metadata ||
      body.byteLength !== metadata.uncompressedSize ||
      crc32(body) !== metadata.crc32 >>> 0
    ) {
      throw new AgentSkillImportError(
        'skill_archive_invalid',
        `${path} failed ZIP size or checksum validation.`,
      );
    }
    expandedBytes += body.byteLength;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Expanded skill archive exceeds the 20 MB limit.',
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new AgentSkillImportError(
        'skill_archive_binary_file',
        `${path} is binary. Skill imports currently accept text files only.`,
      );
    }
    files.push({ path, content });
  }
  return validateAgentSkillFiles(files);
}

export function generateAgentSkill(input: { name?: string; brief: string }): ValidatedAgentSkill {
  const brief = input.brief.trim();
  if (!brief || brief.length > 12_000) {
    throw new AgentSkillImportError(
      'skill_brief_invalid',
      'Skill brief must contain 1 to 12000 characters.',
    );
  }
  const inferred = (input.name?.trim() || brief.split(/[.!?\n]/, 1)[0] || 'custom-skill')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const slug = SLUG_RE.test(inferred)
    ? inferred
    : `custom-skill-${crypto.randomUUID().slice(0, 8)}`;
  const description = brief.replace(/\s+/g, ' ').slice(0, 500);
  const content = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${slug}\n\n${brief}\n`;
  const generated = validateAgentSkillFiles([{ path: `${slug}/SKILL.md`, content }])[0];
  if (!generated) {
    throw new AgentSkillImportError(
      'skill_file_missing',
      'Generated skill validation returned no skill.',
    );
  }
  return generated;
}
