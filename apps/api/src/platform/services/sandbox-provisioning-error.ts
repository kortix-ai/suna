export type SandboxProvisioningFailureCategory =
  | 'provider-capacity'
  | 'git-auth'
  | 'sandbox-provider';

export interface SandboxProvisioningFailure {
  category: SandboxProvisioningFailureCategory;
  userMessage: string;
  isCapacity: boolean;
  isGitAuth: boolean;
}

export const SANDBOX_PROVIDER_CAPACITY_MESSAGE =
  'The sandbox provider is at capacity right now. Try again in a minute.';

export const SANDBOX_PROVIDER_FAILURE_MESSAGE =
  'The sandbox provider could not start this session. Try again.';

const CAPACITY_PATTERN =
  /no available runner|no runners available|no capacity|out of capacity|capacity exceeded|rate ?limit|too many requests|maximum number of concurrent (?:e2b )?sandboxes|max(?:imum)? number of running sandboxes(?: on node)? reached|too many sandboxes starting on this node/i;

const GIT_AUTH_PATTERN =
  /could not read Username|terminal prompts disabled|Authentication failed|fatal: could not read|Invalid username or password|remote: Repository not found|HTTP 401|HTTP 403|access denied|Permission denied \(publickey\)/i;

/**
 * Convert a provider or initialization error into one stable user contract.
 * The raw provider message remains in diagnostic metadata. It is not user copy.
 */
export function classifySandboxProvisioningFailure(error: unknown): SandboxProvisioningFailure {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const isCapacity = CAPACITY_PATTERN.test(rawMessage);
  const isGitAuth = !isCapacity && GIT_AUTH_PATTERN.test(rawMessage);

  if (isCapacity) {
    return {
      category: 'provider-capacity',
      userMessage: SANDBOX_PROVIDER_CAPACITY_MESSAGE,
      isCapacity: true,
      isGitAuth: false,
    };
  }

  if (isGitAuth) {
    return {
      category: 'git-auth',
      userMessage:
        "Couldn't access the project's Git repository. Check the project's Git credentials and try again.",
      isCapacity: false,
      isGitAuth: true,
    };
  }

  return {
    category: 'sandbox-provider',
    userMessage: SANDBOX_PROVIDER_FAILURE_MESSAGE,
    isCapacity: false,
    isGitAuth: false,
  };
}
