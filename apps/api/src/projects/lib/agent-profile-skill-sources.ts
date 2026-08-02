import { getCatalogItemDetail, getCatalogItemFile } from '../../marketplace/catalog';
import { safeEgressFetch } from '../../shared/ssrf-guard';
import {
  AGENT_SKILL_EXPANDED_MAX_BYTES,
  AGENT_SKILL_FILE_MAX_BYTES,
  AGENT_SKILL_FILE_MAX_COUNT,
  AgentSkillImportError,
  type ValidatedAgentSkill,
  validateAgentSkillFiles,
} from './agent-profile-skills';

export async function loadMarketplaceAgentSkills(itemId: string): Promise<ValidatedAgentSkill[]> {
  const detail = await getCatalogItemDetail(itemId);
  if (!detail || detail.type !== 'registry:skill') {
    throw new AgentSkillImportError(
      'marketplace_skill_not_found',
      'The selected marketplace skill is unavailable.',
    );
  }
  if (detail.files.length === 0 || detail.files.length > AGENT_SKILL_FILE_MAX_COUNT) {
    throw new AgentSkillImportError(
      'skill_archive_file_count',
      `Marketplace skills must contain 1 to ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
    );
  }
  const files: Array<{ path: string; content: string }> = [];
  let expandedBytes = 0;
  for (const { target } of detail.files) {
    const file = await getCatalogItemFile(itemId, target);
    if (!file) {
      throw new AgentSkillImportError(
        'marketplace_skill_file_unavailable',
        `Marketplace skill file ${target} is unavailable.`,
      );
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${target} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += bytes;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'Marketplace skill files exceed the 20 MB expanded-size limit.',
      );
    }
    files.push({ path: file.target, content: file.content });
  }
  return validateAgentSkillFiles(files);
}

interface GitHubLocation {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export function parseGitHubSkillUrl(rawUrl: string): GitHubLocation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AgentSkillImportError('github_skill_url_invalid', 'GitHub skill URL is invalid.');
  }
  if (url.protocol !== 'https:') {
    throw new AgentSkillImportError('github_skill_url_invalid', 'GitHub skill URL must use HTTPS.');
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...pathParts] = segments;
    if (!owner || !repo || !ref || (kind !== 'tree' && kind !== 'blob')) {
      throw new AgentSkillImportError(
        'github_skill_url_invalid',
        'Use a GitHub folder or SKILL.md URL that includes a branch or tag.',
      );
    }
    const path = kind === 'blob' ? pathParts.slice(0, -1).join('/') : pathParts.join('/');
    if (kind === 'blob' && pathParts.at(-1) !== 'SKILL.md') {
      throw new AgentSkillImportError(
        'github_skill_url_invalid',
        'GitHub file URL must point to SKILL.md.',
      );
    }
    return { owner, repo: repo.replace(/\.git$/, ''), ref, path };
  }
  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...pathParts] = segments;
    if (!owner || !repo || !ref || pathParts.at(-1) !== 'SKILL.md') {
      throw new AgentSkillImportError(
        'github_skill_url_invalid',
        'Raw GitHub URL must point to SKILL.md.',
      );
    }
    return { owner, repo, ref, path: pathParts.slice(0, -1).join('/') };
  }
  throw new AgentSkillImportError(
    'github_skill_url_invalid',
    'GitHub skill URL must use github.com or raw.githubusercontent.com.',
  );
}

interface GitHubContentEntry {
  type: 'dir' | 'file';
  name: string;
  path: string;
  size?: number;
  download_url?: string | null;
}

async function githubJson(url: string): Promise<GitHubContentEntry | GitHubContentEntry[]> {
  const response = await safeEgressFetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-agent-profile' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new AgentSkillImportError(
      'github_skill_unavailable',
      `GitHub returned HTTP ${response.status} for the selected skill.`,
    );
  }
  return (await response.json()) as GitHubContentEntry | GitHubContentEntry[];
}

export async function loadGitHubAgentSkills(rawUrl: string): Promise<ValidatedAgentSkill[]> {
  const location = parseGitHubSkillUrl(rawUrl);
  const rootPath = location.path.replace(/^\/+|\/+$/g, '');
  const pending = [rootPath];
  const entries: GitHubContentEntry[] = [];
  let traversedEntries = 0;
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined) break;
    const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const suffix = encodedPath ? `/contents/${encodedPath}` : '/contents';
    const url = `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}${suffix}?ref=${encodeURIComponent(location.ref)}`;
    const result = await githubJson(url);
    for (const entry of Array.isArray(result) ? result : [result]) {
      traversedEntries += 1;
      if (traversedEntries > AGENT_SKILL_FILE_MAX_COUNT * 2) {
        throw new AgentSkillImportError(
          'skill_archive_file_count',
          'GitHub skill contains too many files or directories.',
        );
      }
      if (entry.type === 'file' && entries.length >= AGENT_SKILL_FILE_MAX_COUNT) {
        throw new AgentSkillImportError(
          'skill_archive_file_count',
          `GitHub skill contains more than ${AGENT_SKILL_FILE_MAX_COUNT} files.`,
        );
      }
      if (entry.type === 'dir') pending.push(entry.path);
      else if (entry.type === 'file') entries.push(entry);
    }
  }
  if (entries.length === 0) {
    throw new AgentSkillImportError('skill_archive_file_count', 'GitHub skill contains no files.');
  }
  let expandedBytes = 0;
  for (const entry of entries) {
    if (!entry.download_url || (entry.size ?? 0) > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${entry.path} is unavailable or exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += Math.max(0, entry.size ?? 0);
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'GitHub skill files exceed the 20 MB expanded-size limit.',
      );
    }
  }

  const files: Array<{ path: string; content: string }> = [];
  expandedBytes = 0;
  for (const entry of entries) {
    const downloadUrl = entry.download_url;
    if (!downloadUrl) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${entry.path} is unavailable or exceeds the 2 MB per-file limit.`,
      );
    }
    const response = await safeEgressFetch(downloadUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new AgentSkillImportError(
        'github_skill_unavailable',
        `GitHub returned HTTP ${response.status} for ${entry.path}.`,
      );
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > AGENT_SKILL_FILE_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_file_too_large',
        `${entry.path} exceeds the 2 MB per-file limit.`,
      );
    }
    expandedBytes += body.byteLength;
    if (expandedBytes > AGENT_SKILL_EXPANDED_MAX_BYTES) {
      throw new AgentSkillImportError(
        'skill_archive_too_large',
        'GitHub skill files exceed the 20 MB expanded-size limit.',
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new AgentSkillImportError(
        'skill_archive_binary_file',
        `${entry.path} is binary. Skill imports currently accept text files only.`,
      );
    }
    const relative = rootPath ? entry.path.slice(rootPath.length + 1) : entry.path;
    files.push({ path: relative, content });
  }
  return validateAgentSkillFiles(files);
}
