/**
 * First-ship provisioning helpers: everything `kortix ship` needs to turn a
 * folder into a NEW cloud project — pick the account, decide where the repo
 * backs (GitHub App import vs generic link), and bind the folder to the
 * project the instant it exists. Split out of ship.ts beside the connector
 * onboarding; the sync path never calls any of these.
 */

import type { Auth } from '../api/auth.ts';
import { type ApiClient, ApiError } from '../api/client.ts';
import { activeHostName } from '../api/config.ts';
import type { AccountMembership, MeResponse, ProjectSummary } from '../api/types.ts';
import { loadLocalManifest } from '../manifest.ts';
import { saveLink } from '../project-link.ts';
import { confirm } from '../prompts.ts';
import { C, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';

/** The ship flags the provisioning helpers read. */
interface ProvisionFlags {
  account?: string;
  yes: boolean;
  dryRun: boolean;
}

export function isGitHubUrl(url: string): boolean {
  return /(^https?:\/\/github\.com\/)|(^git@github\.com:)/i.test(url);
}

interface LinkRepoResponse {
  project: ProjectSummary;
}

/**
 * Link an existing GitHub repo to a new cloud project — the same import the
 * web UI does, from your terminal. Default path is the one-click GitHub App
 * install (no secret to manage): if the app isn't installed yet, we print the
 * install link, you authorize, and we retry. `--github-token <PAT>` skips the
 * app entirely (the App-free fallback — handy where the app can't be installed,
 * e.g. local dev whose callback points at prod).
 */
export async function linkGitHubBackedProject(
  client: ApiClient,
  opts: { repoUrl: string; name: string; accountId: string; githubToken?: string; yes: boolean },
): Promise<ProjectSummary> {
  const body = (token?: string) => ({
    repo_url: opts.repoUrl,
    name: opts.name,
    account_id: opts.accountId,
    ...(token ? { github_token: token } : {}),
  });

  // PAT path: one shot, no app needed.
  if (opts.githubToken) {
    const res = await client.post<LinkRepoResponse>(
      '/projects/link-repository',
      body(opts.githubToken),
    );
    return res.project;
  }

  // App path: retry around the one-click install.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await client.post<LinkRepoResponse>('/projects/link-repository', body());
      return res.project;
    } catch (err) {
      const installUrl =
        err instanceof ApiError && err.status === 409
          ? ((err.body as { install_url?: string } | null)?.install_url ?? null)
          : null;
      if (!installUrl) throw err;

      process.stdout.write(
        `\n  ${status.warn('Kortix GitHub App not installed for this repo yet.')}\n` +
          `  ${C.dim}One-click install (authorize access to your repo):${C.reset}\n` +
          `  ${C.cyan}${installUrl}${C.reset}\n\n` +
          `  ${C.dim}Or skip the app with a token: ${C.reset}${C.cyan}kortix ship --github-token <PAT>${C.reset}\n\n`,
      );
      if (opts.yes) {
        throw new Error(
          'GitHub App install required — re-run without -y after installing, or pass --github-token <PAT>.',
        );
      }
      const again = await confirm('Installed it? Retry the link', true);
      if (!again)
        throw new Error(
          'Aborted — install the Kortix GitHub App (or use --github-token) then run `kortix ship` again.',
        );
    }
  }
  throw new Error(
    'GitHub App still not detected after several tries — install it, or use --github-token <PAT>.',
  );
}

/** Write `.kortix/link.json` so this folder is bound to the cloud project.
 *  Called the moment the project exists — see the note at its first-ship call
 *  site for why ordering matters. */
export function bindShippedFolder(
  project: ProjectSummary,
  hostName: string | undefined,
  auth: Auth,
): void {
  saveLink({
    project_id: project.project_id,
    account_id: project.account_id,
    host: hostName ?? activeHostName() ?? 'default',
    host_url: auth.api_base,
    linked_at: new Date().toISOString(),
  });
}

/** The display name from kortix.yaml's project.name, if present. Lets a
 *  first ship honor the manifest instead of defaulting to the folder name. */
export function manifestProjectName(): string | undefined {
  try {
    const m = loadLocalManifest();
    const project = m?.data?.project as { name?: unknown } | undefined;
    const name = typeof project?.name === 'string' ? project.name.trim() : '';
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve which account a new project should belong to:
 *   --account flag (id or slug) → exact match
 *   single account               → that one
 *   multiple accounts            → prompt (unless -y / non-interactive / dry-run,
 *                                  which fall back to the active account)
 */
export async function resolveShipAccount(
  client: ApiClient,
  auth: Auth,
  flags: ProvisionFlags,
): Promise<string> {
  let accounts: AccountMembership[] = [];
  try {
    accounts = (await client.get<MeResponse>('/accounts/me')).accounts ?? [];
  } catch {
    // Couldn't list accounts — fall back to the active one.
    return auth.account_id;
  }

  if (flags.account) {
    const match = accounts.find((a) => a.account_id === flags.account || a.slug === flags.account);
    if (!match) {
      const known = accounts.map((a) => a.slug).join(', ') || '(none)';
      throw new Error(`No account "${flags.account}" — you belong to: ${known}`);
    }
    return match.account_id;
  }

  if (accounts.length <= 1) return accounts[0]?.account_id ?? auth.account_id;

  // Multiple accounts: only prompt in an interactive run.
  if (flags.yes || flags.dryRun || process.stdout.isTTY !== true) {
    return auth.account_id;
  }
  const picked = await selectFromList<AccountMembership>({
    title: 'Ship to which account?',
    items: accounts.map((a) => ({
      value: a,
      label: a.name,
      sublabel: `${a.slug} · ${a.role}`,
    })),
  });
  if (!picked) throw new Error('No account selected.');
  return picked.account_id;
}
