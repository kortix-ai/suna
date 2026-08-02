import {
  getCatalogItemDetail,
  getCatalogItemFile,
} from '../../marketplace/catalog';
import { safeEgressFetch } from '../../shared/ssrf-guard';
import {
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
  const files = await Promise.all(
    detail.files.map(async ({ target }) => {
      const file = await getCatalogItemFile(itemId, target);
      if (!file) {
        throw new AgentSkillImportError(
          'marketplace_skill_file_unavailable',
          `Marketplace skill file ${target} is unavailable.`,
        );
      }
      return { path: file.target, content: file.content };
    }),
  );
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
      throw new AgentSkillImportError('github_skill_url_invalid', 'GitHub file URL must point to SKILL.md.');
    }
    return { owner, repo: repo.replace(/\.git$/, ''), ref, path };
  }
  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...pathParts] = segments;
    if (!owner || !repo || !ref || pathParts.at(-1) !== 'SKILL.md') {
      throw new AgentSkillImportError('github_skill_url_invalid', 'Raw GitHub URL must point to SKILL.md.');
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
  while (pending.length > 0) {
    const path = pending.shift()!;
    const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const suffix = encodedPath ? `/contents/${encodedPath}` : '/contents';
    const url = `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}${suffix}?ref=${encodeURIComponent(location.ref)}`;
    const result = await githubJson(url);
    for (const entry of Array.isArray(result) ? result : [result]) {
      if (entries.length + pending.length >= 100) {
        throw new AgentSkillImportError(
          'skill_archive_file_count',
          'GitHub skill contains more than 100 files.',
        );
      }
      if (entry.type === 'dir') pending.push(entry.path);
      else if (entry.type === 'file') entries.push(entry);
    }
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.download_url || (entry.size ?? 0) > 2 * 1024 * 1024) {
        throw new AgentSkillImportError(
          'skill_archive_file_too_large',
          `${entry.path} is unavailable or exceeds the 2 MB per-file limit.`,
        );
      }
      const response = await safeEgressFetch(entry.download_url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new AgentSkillImportError(
          'github_skill_unavailable',
          `GitHub returned HTTP ${response.status} for ${entry.path}.`,
        );
      }
      const relative = rootPath ? entry.path.slice(rootPath.length + 1) : entry.path;
      return { path: relative, content: await response.text() };
    }),
  );
  return validateAgentSkillFiles(files);
}
