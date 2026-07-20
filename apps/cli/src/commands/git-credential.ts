import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { clientFromAuth } from '../api/client.ts';
import type { ProjectSummary } from '../api/types.ts';
import { loadLink } from '../project-link.ts';
import { resolveProjectCloneTarget } from './projects.ts';

export type GitCredentialRequest = Record<string, string>;

export function parseGitCredentialRequest(raw: string): GitCredentialRequest {
  const result: GitCredentialRequest = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

export function gitCredentialRequestUrl(request: GitCredentialRequest): string | null {
  if (request.url?.startsWith('http://') || request.url?.startsWith('https://')) {
    return request.url;
  }
  if (!request.protocol || !request.host) return null;
  const path = request.path ? `/${request.path.replace(/^\/+/, '')}` : '';
  return `${request.protocol}://${request.host}${path}`;
}

function canonicalGitUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export interface ResolvedGitCredential {
  username: string;
  password: string;
}

export async function resolveGitCredentialForProject(input: {
  requestUrl: string;
  project: ProjectSummary;
  kortixToken: string;
  mintManagedToken: () => Promise<{ push_token: string; git_username?: string }>;
}): Promise<ResolvedGitCredential | null> {
  const target = resolveProjectCloneTarget(input.project, input.kortixToken);
  if (canonicalGitUrl(target.repoUrl) !== canonicalGitUrl(input.requestUrl)) return null;

  let token = target.token;
  let username = target.username;
  if (target.needsManagedToken) {
    const credential = await input.mintManagedToken();
    token = credential.push_token;
    username = credential.git_username || username;
  }

  return token ? { username, password: token } : null;
}

async function stdinText(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('');
}

/** Git credential-helper protocol. Hidden from normal CLI help. */
export async function runGitCredential(argv: string[]): Promise<number> {
  const operation = argv[0];
  if (operation === 'store' || operation === 'erase') return 0;
  if (operation !== 'get') return 2;

  const requestUrl = gitCredentialRequestUrl(parseGitCredentialRequest(await stdinText()));
  const link = loadLink();
  if (!requestUrl || !link?.project_id) return 0;

  const auth = link.host ? loadAuthForHost(link.host) : loadAuth();
  if (!auth?.token) {
    const hint = link.host ? ` --host ${link.host}` : '';
    process.stderr.write(`Kortix Git needs login. Run: kortix login${hint}\n`);
    process.stdout.write('quit=true\n\n');
    return 0;
  }

  const client = clientFromAuth(auth);
  let project: ProjectSummary;
  try {
    project = await client.get<ProjectSummary>(`/projects/${link.project_id}`);
  } catch (error) {
    process.stderr.write(`Kortix Git could not load the linked project: ${(error as Error).message}\n`);
    process.stdout.write('quit=true\n\n');
    return 0;
  }

  let credential: ResolvedGitCredential | null;
  try {
    credential = await resolveGitCredentialForProject({
      requestUrl,
      project,
      kortixToken: auth.token,
      mintManagedToken: () =>
        client.post<{ push_token: string; git_username?: string }>(
          `/projects/${project.project_id}/git-token`,
        ),
    });
  } catch (error) {
    process.stderr.write(`Kortix Git could not mint a repository credential: ${(error as Error).message}\n`);
    process.stdout.write('quit=true\n\n');
    return 0;
  }

  if (!credential) return 0;
  process.stdout.write(
    `username=${credential.username}\npassword=${credential.password}\nquit=true\n\n`,
  );
  return 0;
}
