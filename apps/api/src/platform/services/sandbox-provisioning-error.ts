export type SandboxProvisioningFailureCategory =
  | 'provider-capacity'
  | 'git-auth'
  | 'unsupported-secret-delivery'
  | 'invalid-secret-boundary-policy'
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

// Names all THREE remedies. It used to say "Select Platinum or change the
// secret delivery policy", which on a deployment that ships no Platinum left
// the reader with one impossible option and one destructive one — and it
// predates the flag that is now the cheapest fix.
export const UNSUPPORTED_SECRET_DELIVERY_MESSAGE =
  'This sandbox provider cannot enforce network-boundary secret delivery. ' +
  'Turn on "Network boundary without Platinum" in Feature flags → Experimental, ' +
  'or run the project on Platinum, or change the secret delivery policy.';

export const INVALID_SECRET_BOUNDARY_POLICY_MESSAGE =
  "A network-boundary secret in this project has an invalid outbound policy, so no session can start. " +
  'Two secrets cannot inject the same header for the same host. Fix the secret delivery settings — retrying will not help.';

const CAPACITY_PATTERN =
  /no available runner|no runners available|no capacity|out of capacity|capacity exceeded|failed to place sandbox|rate ?limit|too many requests|maximum number of concurrent (?:e2b )?sandboxes|max(?:imum)? number of running sandboxes(?: on node)? reached|too many sandboxes starting on this node/i;

const GIT_AUTH_PATTERN =
  /could not read Username|terminal prompts disabled|Authentication failed|fatal: could not read|Invalid username or password|remote: Repository not found|HTTP 401|HTTP 403|access denied|Permission denied \(publickey\)/i;

const UNSUPPORTED_SECRET_DELIVERY_PATTERN =
  /does not support network-boundary secret delivery/i;

/**
 * The project's own network-boundary config is unusable, so `resolveNetworkBoundaryBindings`
 * refuses the whole set before any provider is contacted.
 *
 * Distinct from `unsupported-secret-delivery`, which is a PROVIDER capability gap. This is a
 * Kortix-side configuration error, and it used to be indistinguishable from a provider fault:
 * with no pattern here it fell through to `sandbox-provider`, whose copy blames the provider and
 * says "Try again" — for a state where retrying can never succeed. Two secrets claiming the same
 * (host, header) is now rejected at save time, so this classifies the configs that predate that
 * check, plus the other policy throws (invalid consumer, missing policy, non-exact host).
 */
const INVALID_SECRET_BOUNDARY_POLICY_PATTERN =
  /both target .+ header |Network-boundary secret |Network-boundary delivery |invalid header injection/i;

/**
 * Convert a provider or initialization error into one stable user contract.
 * The raw provider message remains in diagnostic metadata. It is not user copy.
 */
export function classifySandboxProvisioningFailure(error: unknown): SandboxProvisioningFailure {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const isCapacity = CAPACITY_PATTERN.test(rawMessage);
  const isGitAuth = !isCapacity && GIT_AUTH_PATTERN.test(rawMessage);

  if (UNSUPPORTED_SECRET_DELIVERY_PATTERN.test(rawMessage)) {
    return {
      category: 'unsupported-secret-delivery',
      userMessage: UNSUPPORTED_SECRET_DELIVERY_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
    };
  }

  if (INVALID_SECRET_BOUNDARY_POLICY_PATTERN.test(rawMessage)) {
    return {
      category: 'invalid-secret-boundary-policy',
      userMessage: INVALID_SECRET_BOUNDARY_POLICY_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
    };
  }

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
