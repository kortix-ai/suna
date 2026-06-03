import { config } from '../config';
import { resolveShareSubject } from '../executor/share';
import { listProjectSecretsSnapshotForUser } from './secrets';

// Env names a project secret must NEVER inject into a sandbox -- they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` would override the runtime and break every session.
const RESERVED_SANDBOX_ENV_NAMES = new Set([
  'PORT', 'PATH', 'HOME', 'PWD', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  'TERM', 'TMPDIR', 'NODE_ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);

function isReservedSandboxEnvName(name: string): boolean {
  return (
    RESERVED_SANDBOX_ENV_NAMES.has(name) ||
    name.startsWith('KORTIX_') ||
    name.startsWith('OPENCODE_')
  );
}

function deriveKortixApiRoot(kortixUrl: string): string {
  return (kortixUrl || 'https://api.kortix.com')
    .replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}

function deriveKortixApiBase(): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1`;
}

/**
 * The Kortix git-proxy origin for a project -- the universal client-facing git
 * URL. Clients clone/push this with a Kortix token; the API resolves upstream.
 */
function proxyGitUrl(projectId: string): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1/git/${projectId}.git`;
}

export async function buildSessionSandboxEnvVars(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  initialPrompt?: string | null;
  opencodeModel?: string | null;
}): Promise<Record<string, string>> {
  // Only user runtime secrets belong here. The sandbox-scoped KORTIX_TOKEN is
  // minted by provisionSessionSandbox() and injected at the provider boundary,
  // then reused by the daemon for both API calls and proxy HMAC validation.
  // Resolved AS the launching user, so personal overrides win and "Only me" /
  // "Select members" secrets only reach members they're shared with.
  const subject = await resolveShareSubject(input.userId);
  const runtimeSecrets = await listProjectSecretsSnapshotForUser(input.projectId, subject);
  // The Slack signing secret only verifies inbound webhooks (an apps/api job).
  // The in-sandbox agent never needs it -- keep it out of the sandbox env.
  delete runtimeSecrets.env.SLACK_SIGNING_SECRET;
  // Guardrail: drop any project secret whose name would clobber the sandbox's
  // own runtime env (PORT/PATH/KORTIX_*/...).
  const droppedReserved = Object.keys(runtimeSecrets.env).filter(isReservedSandboxEnvName);
  for (const name of droppedReserved) delete runtimeSecrets.env[name];
  if (droppedReserved.length > 0) {
    console.warn(
      `[session ${input.sessionId}] ignored ${droppedReserved.length} project secret(s) with reserved env names: ${droppedReserved.join(', ')}`,
    );
  }
  return {
    ...runtimeSecrets.env,
    KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
    KORTIX_PROJECT_SECRETS_REVISION: runtimeSecrets.revision,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    // Universal proxy origin: when enabled, the sandbox clones via the Kortix
    // git proxy with its own KORTIX_TOKEN -- a real host credential never lands
    // in the sandbox. OFF -> direct clone of the real repo.
    KORTIX_REPO_URL: config.KORTIX_GIT_PROXY ? proxyGitUrl(input.projectId) : input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_API_URL: deriveKortixApiBase(),
    ...(input.initialPrompt
      ? {
          KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1',
          KORTIX_INITIAL_PROMPT: input.initialPrompt,
        }
      : {}),
    // Per-session model override (e.g. Slack turns pin a specific model).
    // The sandbox agent reads this and sets it on every opencode prompt call.
    ...(input.opencodeModel ? { KORTIX_OPENCODE_MODEL: input.opencodeModel } : {}),
  };
}
