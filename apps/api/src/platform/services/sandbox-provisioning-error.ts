export type SandboxProvisioningFailureCategory =
  | 'provider-capacity'
  | 'git-auth'
  | 'invalid-secret-boundary-policy'
  | 'snapshot-too-large'
  | 'drives-unavailable'
  | 'sandbox-provider';

export interface SandboxProvisioningFailure {
  category: SandboxProvisioningFailureCategory;
  userMessage: string;
  isCapacity: boolean;
  isGitAuth: boolean;
  /**
   * The same input may succeed on a later attempt: the provider was at
   * capacity, rate limited, or answered a transient 5xx. A transient failure
   * keeps the session's volume and is re-attempted by the next `/start`; every
   * other category is a configuration state that fails identically each time.
   */
  transient: boolean;
}

export const SANDBOX_PROVIDER_CAPACITY_MESSAGE =
  'The sandbox provider is at capacity right now. Try again in a minute.';

export const SANDBOX_PROVIDER_FAILURE_MESSAGE =
  'The sandbox provider could not start this session. Try again.';

export const SANDBOX_PROVIDER_STORAGE_FULL_MESSAGE =
  'The sandbox provider is out of storage, so no new session can start on it. ' +
  'Try again later, or ask a project admin to switch the sandbox provider in Customize → Settings → Sandbox.';

export const INVALID_SECRET_BOUNDARY_POLICY_MESSAGE =
  "A network-boundary secret in this project has an invalid outbound policy, so no session can start. " +
  'Two secrets cannot inject the same header for the same host. Fix the secret delivery settings — retrying will not help.';

export const SNAPSHOT_TOO_LARGE_MESSAGE =
  "This project's sandbox image is larger than the provider allows, so no session can start on it. " +
  'Slim the image down — retrying will not help.';

/**
 * The project's custom sandbox image is over the provider's snapshot ceiling.
 *
 * PERMANENT and user-fixable, and it used to be neither: with no pattern here it
 * fell through to `sandbox-provider`, whose copy blames the provider and tells
 * the user to "Try again" — for a build that can never succeed. Prod
 * 2026-09-16: a project's `kortix-tpl-` snapshot measured 10.04 GB against
 * Daytona's 10 GB cap, and every new Daytona session on that project either
 * sat in `provisioning` or came back with "The sandbox provider could not
 * start this session. Try again." The 40 MB it was over was nowhere in the
 * message, so there was nothing to act on.
 */
const SNAPSHOT_TOO_LARGE_PATTERN =
  /exceeds maximum allowed size|snapshot size .* exceeds|image (?:size )?too large|exceeds the maximum snapshot size/i;

/**
 * The provider organization's storage quota is full. Capacity, but not "a
 * minute": it frees only as the provider archives stopped boxes. Prod
 * 2026-10-06: Daytona answered "Total disk limit exceeded. Maximum allowed:
 * 40000GiB." to a pinned project for 13 hours, and every failed session said
 * "could not start this session. Try again."
 */
const STORAGE_FULL_PATTERN = /total disk limit exceeded|disk quota exceeded|storage quota exceeded/i;

const CAPACITY_PATTERN =
  /resource pool exhausted|too many starts in flight|no available runner|no runners available|no capacity|out of capacity|capacity exceeded|failed to place sandbox|rate ?limit|too many requests|maximum number of concurrent (?:e2b )?sandboxes|max(?:imum)? number of running sandboxes(?: on node)? reached|too many sandboxes starting on this node/i;

/**
 * A provider answer that says "not now" rather than "never": 429, or a 5xx a
 * later attempt can clear. Matches the status as each provider SDK prints it
 * (`-> 503 {...}`, `status code 502`, `HTTP 504`).
 */
const TRANSIENT_HTTP_PATTERN = /(?:->|\bstatus(?: code)?:?|\bHTTP(?:\/[\d.]+)?)\s*(?:429|500|502|503|504)\b/i;

const GIT_AUTH_PATTERN =
  /could not read Username|terminal prompts disabled|Authentication failed|fatal: could not read|Invalid username or password|remote: Repository not found|HTTP 401|HTTP 403|access denied|Permission denied \(publickey\)/i;

/**
 * The project's own network-boundary config is unusable, so `resolveNetworkBoundaryBindings`
 * refuses the whole set before any provider is contacted.
 *
 * A Kortix-side configuration error, and it used to be indistinguishable from a provider fault:
 * with no pattern here it fell through to `sandbox-provider`, whose copy blames the provider and
 * says "Try again" — for a state where retrying can never succeed. Two secrets claiming the same
 * (host, header) is now rejected at save time, so this classifies the configs that predate that
 * check, plus the other policy throws (invalid consumer, missing policy, non-exact host).
 *
 * There is no longer a PROVIDER capability gap to distinguish it from: one mechanism serves
 * daytona, e2b and platinum alike, so
 * the `unsupported-secret-delivery` category is never produced. It stays on the wire contract
 * because sandbox rows written before this change still carry it.
 */
const INVALID_SECRET_BOUNDARY_POLICY_PATTERN =
  /both target .+ header |Network-boundary secret |Network-boundary delivery |invalid header injection/i;

/**
 * Convert a provider or initialization error into one stable user contract.
 * The raw provider message remains in diagnostic metadata. It is not user copy.
 */
export function classifySandboxProvisioningFailure(error: unknown): SandboxProvisioningFailure {
  const rawMessage = error instanceof Error ? error.message : String(error);

  // Kortix Drive: the session's drives did not mount, so it did not start.
  // The message already says which drives and why (drives/service.ts).
  if (rawMessage.startsWith('[drives] ')) {
    return {
      category: 'drives-unavailable',
      userMessage: rawMessage.slice('[drives] '.length),
      isCapacity: false,
      isGitAuth: false,
      transient: false,
    };
  }
  const isStorageFull = STORAGE_FULL_PATTERN.test(rawMessage);
  const isCapacity = isStorageFull || CAPACITY_PATTERN.test(rawMessage);
  const isGitAuth = !isCapacity && GIT_AUTH_PATTERN.test(rawMessage);

  if (INVALID_SECRET_BOUNDARY_POLICY_PATTERN.test(rawMessage)) {
    return {
      category: 'invalid-secret-boundary-policy',
      userMessage: INVALID_SECRET_BOUNDARY_POLICY_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
      transient: false,
    };
  }

  // Before the capacity branch: a provider at capacity is transient, this is
  // not, and a message that says "try again in a minute" for a 10 GB image is
  // worse than no message.
  if (SNAPSHOT_TOO_LARGE_PATTERN.test(rawMessage)) {
    return {
      category: 'snapshot-too-large',
      userMessage: SNAPSHOT_TOO_LARGE_MESSAGE,
      isCapacity: false,
      isGitAuth: false,
      transient: false,
    };
  }

  if (isCapacity) {
    return {
      category: 'provider-capacity',
      userMessage: isStorageFull ? SANDBOX_PROVIDER_STORAGE_FULL_MESSAGE : SANDBOX_PROVIDER_CAPACITY_MESSAGE,
      isCapacity: true,
      isGitAuth: false,
      transient: true,
    };
  }

  if (isGitAuth) {
    return {
      category: 'git-auth',
      userMessage:
        "Couldn't access the project's Git repository. Check the project's Git credentials and try again.",
      isCapacity: false,
      isGitAuth: true,
      transient: false,
    };
  }

  return {
    category: 'sandbox-provider',
    userMessage: SANDBOX_PROVIDER_FAILURE_MESSAGE,
    isCapacity: false,
    isGitAuth: false,
    transient: TRANSIENT_HTTP_PATTERN.test(rawMessage),
  };
}
